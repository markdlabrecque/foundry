/**
 * Stopping one named factory (PRD §10.3): `foundry factory stop <name> [--force]`.
 *
 * A stop marks the factory `stopping` before anything else, so scheduling launches nothing more in
 * its scope, and waits for any scheduling already under way to finish. Unless forced, it sends
 * `drain` to the factory's live workers and allows a bounded grace period for their
 * acknowledgements. Then the Worker Host terminates every process group the factory owns (SIGTERM,
 * the grace period, then SIGKILL; `--force` kills at once). Other factories' launches are never
 * named, so they are never signalled.
 *
 * Success (`factory.stopped`) needs positive evidence that every owned group is gone. A group the
 * host reports `unconfirmed`, a terminate the host refuses or never answers, or a launch the daemon
 * recorded that the host no longer knows in this boot, fails the stop: the factory stays
 * `stopping`, its slots keep their launches, and the stop may be retried. Factory states live for
 * the run only: a stopped factory comes back on the next daemon start.
 */
import { Effect } from "effect";
import type { LaunchRecord, TerminateOptions, Termination } from "@foundry/host";
import { messageOf } from "@foundry/protocol/errors";
import type { FactoryState, FactoryStopResult, StoppedLaunch } from "@foundry/protocol/factories-api";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Store, StoreError } from "./store.js";

/** Default grace period: how long drain acknowledgements are awaited, and SIGTERM before SIGKILL. */
export const DEFAULT_STOP_GRACE_MS = 5000;

/** Default wait for a group to vanish after SIGKILL. */
export const DEFAULT_STOP_KILL_WAIT_MS = 5000;

/** The state of each started factory in this run. */
export interface FactoryStates {
  get(factoryId: string): FactoryState | undefined;
  set(factoryId: string, state: FactoryState): void;
  /** True only for a started factory that no stop has touched: scheduling's scope. */
  isRunning(factoryId: string): boolean;
}

/** Every started factory begins the run `running`. */
export const createFactoryStates = (started: ReadonlyArray<string>): FactoryStates => {
  const states = new Map<string, FactoryState>(started.map((id) => [id, "running"]));

  return {
    get: (factoryId) => states.get(factoryId),
    set: (factoryId, state) => void states.set(factoryId, state),
    isRunning: (factoryId) => states.get(factoryId) === "running",
  };
};

export type FactoryStopErrorCode = "unknown_factory" | "factory_stopped" | "stop_unconfirmed";

/** A stop the daemon refuses or could not confirm, with a stable API code. */
export class FactoryStopError extends Error {
  override readonly name = "FactoryStopError";
  constructor(
    readonly code: FactoryStopErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a stop needs from the Worker Host; a `HostConnection` satisfies it. */
export interface StopHost {
  inventory(): Promise<ReadonlyArray<LaunchRecord>>;
  terminate(launchId: string, options?: TerminateOptions): Promise<Termination>;
}

export interface FactoryStopperOptions {
  readonly store: Store;
  readonly states: FactoryStates;
  /** The Worker Host and its identity; absent when no factory has a slot, so nothing was launched. */
  readonly host?: {
    readonly connection: StopHost;
    readonly hostId: string;
    readonly bootId: string;
  };
  /** Waits for scheduling under way; records host-reported exits. */
  readonly scheduler?: {
    idle(): Promise<void>;
    recordExit(launch: LaunchRecord): Promise<boolean>;
  };
  /** Sends `drain` on a launch's channel and resolves on its acknowledgement; absent without a channel. */
  readonly drain?: (launchId: string) => Promise<void>;
  readonly graceMs?: number;
  readonly killWaitMs?: number;
}

export interface FactoryStopper {
  /**
   * Stops `factoryId`. Resolves only once every owned process group is confirmed gone. A stop
   * already under way for the factory is joined, whatever `force` asks.
   */
  stop(factoryId: string, force: boolean): Promise<FactoryStopResult>;
}

interface SlotLaunchRow {
  readonly slot_id: string;
  readonly current_launch: string | null;
  readonly pending_host: string | null;
  readonly pending_boot: string | null;
  readonly boot_id: string | null;
  readonly ended_at: number | null;
}

/**
 * Recorded work the host cannot account for in this boot: a current launch it does not know, or a
 * launch requested of an earlier host process. Either may still be running, so neither is gone.
 */
const unaccounted = (
  store: Store,
  factoryId: string,
  inventory: ReadonlyArray<LaunchRecord>,
  host: { readonly hostId: string; readonly bootId: string },
): Effect.Effect<ReadonlyArray<string>, StoreError> =>
  Effect.map(
    store.read<SlotLaunchRow>(
      `SELECT s.slot_id, s.current_launch, s.pending_host, s.pending_boot, l.boot_id, l.ended_at
       FROM slot s LEFT JOIN launch l ON l.launch_id = s.current_launch
       WHERE s.factory_id = ? ORDER BY s.slot_id`,
      [factoryId],
    ),
    (rows) => {
      const known = new Set(inventory.map((launch) => launch.launchId));
      const problems: Array<string> = [];

      for (const row of rows) {
        // A launch from another boot is gone: the machine restarted (PRD §10.2).
        if (row.current_launch !== null && row.ended_at === null && !known.has(row.current_launch) && row.boot_id === host.bootId) {
          problems.push(`${row.slot_id}: the worker host does not know launch ${row.current_launch}`);
        }

        if (row.pending_host !== null && row.pending_host !== host.hostId && row.pending_boot === host.bootId) {
          problems.push(`${row.slot_id}: a launch requested of an earlier worker host may still run`);
        }
      }

      return problems;
    },
  );

/** What a `factory.stopping` or `factory.stopped` history row records. */
interface FactoryStopDetail {
  readonly force: boolean;
  /** On `factory.stopped`: how many owned launches were confirmed gone. */
  readonly launches?: number;
}

const recordFactory = (
  store: Store,
  factoryId: string,
  kind: "factory.stopping" | "factory.stopped",
  detail: FactoryStopDetail,
) =>
  Effect.runPromise(store.change((change) => change.recordHistory({ factoryId, kind, subject: factoryId, detail })));

/** Resolves true once `work` settles within `ms`, false on timeout or failure. */
const within = async (work: Promise<void>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

type Ended = { readonly ok: true; readonly termination: Termination } | { readonly ok: false; readonly error: string };

export const createFactoryStopper = (options: FactoryStopperOptions): FactoryStopper => {
  const { store, states } = options;
  const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_STOP_KILL_WAIT_MS;
  const underway = new Map<string, Promise<FactoryStopResult>>();

  const run = async (factoryId: string, force: boolean): Promise<FactoryStopResult> => {
    // Set before any await, so no scheduling that starts from here on launches into the factory.
    states.set(factoryId, "stopping");
    await recordFactory(store, factoryId, "factory.stopping", { force });
    await options.scheduler?.idle();

    const host = options.host;

    if (host === undefined) {
      states.set(factoryId, "stopped");
      await recordFactory(store, factoryId, "factory.stopped", { force, launches: 0 });

      return { factoryId, state: "stopped", force, launches: [] };
    }

    const inventory = await host.connection.inventory();
    // Ended launches too: the host confirms each group empty, descendants included, before success.
    const owned = inventory.filter((launch) => launch.factoryId === factoryId);
    const problems = [...(await Effect.runPromise(unaccounted(store, factoryId, inventory, host)))];
    const drain = options.drain;

    const drained = new Set<string>();

    if (!force && drain !== undefined) {
      const live = owned.filter((launch) => launch.liveness === "live");
      const acks = await Promise.all(live.map((launch) => within(drain(launch.launchId), graceMs)));

      for (const [index, launch] of live.entries()) {
        if (acks[index] === true) {drained.add(launch.launchId);}
      }
    }

    const ends = await Promise.all(
      owned.map((launch) =>
        host.connection.terminate(launch.launchId, { graceMs: force ? 0 : graceMs, killWaitMs }).then(
          (termination): Ended => ({ ok: true, termination }),
          (cause: unknown): Ended => ({ ok: false, error: messageOf(cause) }),
        ),
      ),
    );

    const stopped: Array<StoppedLaunch> = [];

    for (const [index, launch] of owned.entries()) {
      const end = ends[index];

      if (end === undefined || !end.ok) {
        problems.push(`${launch.slotId}: launch ${launch.launchId} was not terminated: ${end?.error ?? "no answer"}`);
        continue;
      }

      // The leader's exit is a fact even when the group is not confirmed empty.
      if (end.termination.launch.liveness === "gone") {await options.scheduler?.recordExit(end.termination.launch);}

      if (end.termination.outcome !== "gone") {
        problems.push(`${launch.slotId}: the process group of launch ${launch.launchId} could not be confirmed gone`);
        continue;
      }

      stopped.push({
        launchId: launch.launchId,
        slotId: launch.slotId,
        drained: drained.has(launch.launchId),
        escalated: end.termination.escalated,
      });
    }

    if (problems.length > 0) {
      throw new FactoryStopError(
        "stop_unconfirmed",
        `factory "${factoryId}" is still stopping; ${problems.length} owned worker(s) not confirmed gone: ${problems.join("; ")}`,
      );
    }

    states.set(factoryId, "stopped");
    await recordFactory(store, factoryId, "factory.stopped", { force, launches: stopped.length });

    return { factoryId, state: "stopped", force, launches: stopped };
  };

  return {
    stop: (factoryId, force) => {
      const state = states.get(factoryId);

      if (state === undefined) {return Promise.reject(new FactoryStopError("unknown_factory", `No running factory "${factoryId}"`));}

      if (state === "stopped") {
        return Promise.reject(new FactoryStopError("factory_stopped", `Factory "${factoryId}" is already stopped`));
      }

      const joined = underway.get(factoryId);

      if (joined !== undefined) {return joined;}

      const stopping = run(factoryId, force).finally(() => underway.delete(factoryId));
      underway.set(factoryId, stopping);

      return stopping;
    },
  };
};
