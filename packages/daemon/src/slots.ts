/**
 * Fixed slots and their launches (PRD §3.2, §5.2–5.3, §10.1, §11.2).
 *
 * Each started factory's configured capacity becomes slots: a persistent station has one, a
 * pooled station `instances` of them, written `station/ordinal`. Scheduling asks the Worker Host
 * which launch holds each slot and launches only into a slot the host confirms vacant and that
 * has never had a launch, so repeated or concurrent scheduling never starts a second launch in a
 * slot. A live launch the daemon has no record of (the daemon died before saving the start reply)
 * is adopted, not duplicated.
 *
 * The `slot` and `launch` tables are current state; every change writes its `launch.*` history
 * row in the same transaction (ADR 0001). Where host and database disagree, the host wins on
 * liveness and the database on everything else.
 *
 * Out of scope here: relaunching a slot whose launch ended (recovery, the recovery limit and the
 * recovery prime), and freezing a slot whose ownership the host cannot confirm (operator holds).
 * Such slots are reported and left alone.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Clock, Effect, Schema } from "effect";
import { buildLaunchArgs, connectHost, HostRefusedError, launchStderrPath, startHost } from "@foundry/host";
import type { HostConnection, LaunchRecord, LaunchSpec, PiExecutable } from "@foundry/host";
import { CHANNEL_SOCKET_ENV, channelSocketPath } from "@foundry/protocol";
import { codeOf, messageOf } from "@foundry/protocol/errors";
import { SLOT_INTERRUPT_ACK_TIMEOUT_MS, SlotCondition, slotIdOf } from "@foundry/protocol/slots-api";
import type { LaunchEndReason, SlotLaunch, SlotLaunchHistoryEntry, SlotSummary } from "@foundry/protocol/slots-api";
import { SlotsError } from "./slots-error.js";
import type { SlotInterrupter, SlotsReader } from "./slots-error.js";
import { ChannelUnavailableError } from "./channel/server.js";
import type { ChannelServer } from "./channel/server.js";
import type { EffectiveStation } from "./config/index.js";
import { slotRecord } from "./history-records.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Change, Store, StoreError } from "./store.js";

/** Directory, relative to the state root, holding each slot's neutral launch folder (PRD §3.2). */
export const SLOTS_DIR_NAME = "slots";

/** One configured slot of a started factory. */
export interface PlannedSlot {
  readonly factoryId: string;
  /** `station/ordinal`. */
  readonly slotId: string;
  readonly ordinal: number;
  readonly station: EffectiveStation;
}

/** A factory's slots from its effective stations, in configuration order (PRD §5.2). */
export const planSlots = (factoryId: string, stations: ReadonlyArray<EffectiveStation>): ReadonlyArray<PlannedSlot> =>
  stations.flatMap((station) =>
    Array.from({ length: station.instances }, (_, index) => ({
      factoryId,
      slotId: slotIdOf(station.station, index + 1),
      ordinal: index + 1,
      station,
    })),
  );

/** The neutral per-slot folder a slot's launches run in, never a worktree or the clone. */
export const slotDirectory = (stateRoot: string, factoryId: string, slotId: string): string =>
  join(stateRoot, SLOTS_DIR_NAME, factoryId, slotId.replace("/", "-"));

/** What the scheduler needs from the Worker Host; a `HostConnection` satisfies it. */
export interface SlotHost {
  inventory(): Promise<ReadonlyArray<LaunchRecord>>;
  launch(spec: LaunchSpec): Promise<LaunchRecord>;
}

interface SlotRow {
  readonly factory_id: string;
  readonly slot_id: string;
  readonly station: string;
  readonly ordinal: number;
  readonly condition: string;
  readonly current_launch: string | null;
  readonly pending_host: string | null;
  readonly pending_boot: string | null;
}

interface LaunchRow {
  readonly launch_id: string;
  readonly factory_id: string;
  readonly slot_id: string;
  readonly boot_id: string;
  readonly pid: number;
  readonly started_at: number;
  readonly origin: "started" | "adopted";
  readonly ended_at: number | null;
  readonly end_reason: LaunchEndReason | null;
  readonly exit_code: number | null;
  readonly exit_signal: string | null;
}

const SLOT_COLUMNS = `factory_id, slot_id, station, ordinal, condition, current_launch, pending_host, pending_boot`;
const LAUNCH_COLUMNS = `launch_id, factory_id, slot_id, boot_id, pid, started_at, origin, ended_at, end_reason, exit_code, exit_signal`;

const readSlot = (store: Store, factoryId: string, slotId: string) =>
  Effect.map(
    store.read<SlotRow>(`SELECT ${SLOT_COLUMNS} FROM slot WHERE factory_id = ? AND slot_id = ?`, [factoryId, slotId]),
    (rows) => rows[0],
  );

const readLaunch = (store: Store, launchId: string) =>
  Effect.map(store.read<LaunchRow>(`SELECT ${LAUNCH_COLUMNS} FROM launch WHERE launch_id = ?`, [launchId]), (rows) => rows[0]);

const insertSlot = (change: Change, slot: PlannedSlot) =>
  change.query(
    `INSERT OR IGNORE INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, ?, ?, ?, 'normal')`,
    [slot.factoryId, slot.slotId, slot.station.address, slot.ordinal],
  );

/** The host process and machine boot a launch is asked of. */
interface HostRef {
  readonly hostId: string;
  readonly bootId: string;
}

/**
 * Records that the daemon is about to ask the host for a launch, creating the slot record if new.
 * The slot keeps the request pending until the launch is recorded, so a daemon that dies between
 * the host's spawn and its record can tell, after restarting, whether a launch may already exist.
 * Its history row's subject is the slot: no launch ID exists yet.
 */
const recordRequested = (store: Store, slot: PlannedSlot, host: HostRef): Effect.Effect<void, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      yield* change.query(
        `INSERT INTO slot (factory_id, slot_id, station, ordinal, condition, pending_host, pending_boot)
         VALUES (?, ?, ?, ?, 'normal', ?, ?)
         ON CONFLICT (factory_id, slot_id) DO UPDATE SET pending_host = excluded.pending_host, pending_boot = excluded.pending_boot`,
        [slot.factoryId, slot.slotId, slot.station.address, slot.ordinal, host.hostId, host.bootId],
      );
      yield* change.recordHistory({
        factoryId: slot.factoryId,
        kind: "launch.requested",
        subject: slot.slotId,
        detail: { station: slot.station.address, hostId: host.hostId },
        records: [slotRecord(slot.slotId)],
      });
    }),
  );

/**
 * Records that the host refused a requested launch, which proves it never started: the request is
 * no longer pending, so a later host in this boot may launch into the slot.
 */
const recordRefused = (store: Store, slot: PlannedSlot, reason: string): Effect.Effect<void, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET pending_host = NULL, pending_boot = NULL WHERE factory_id = ? AND slot_id = ?`, [
        slot.factoryId,
        slot.slotId,
      ]);
      yield* change.recordHistory({
        factoryId: slot.factoryId,
        kind: "launch.refused",
        subject: slot.slotId,
        detail: { station: slot.station.address, reason },
        records: [slotRecord(slot.slotId)],
      });
    }),
  );

/**
 * Records a launch the host reports as the slot's current launch: one it `started` for us, or one
 * `adopted`. A launch already recorded is not inserted again; it only becomes current. Clears any
 * pending request.
 */
const recordLaunch = (
  store: Store,
  slot: PlannedSlot,
  launch: LaunchRecord,
  origin: "started" | "adopted",
): Effect.Effect<void, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      yield* insertSlot(change, slot);
      yield* change.query(
        `INSERT INTO launch (launch_id, factory_id, slot_id, boot_id, pid, started_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (launch_id) DO NOTHING`,
        [launch.launchId, launch.factoryId, launch.slotId, launch.bootId, launch.pid, Date.parse(launch.startedAt), origin],
      );
      yield* change.query(`UPDATE slot SET current_launch = ?, pending_host = NULL, pending_boot = NULL WHERE factory_id = ? AND slot_id = ?`, [
        launch.launchId,
        slot.factoryId,
        slot.slotId,
      ]);
      yield* change.recordHistory({
        factoryId: slot.factoryId,
        kind: origin === "started" ? "launch.started" : "launch.adopted",
        subject: launch.launchId,
        detail: { slotId: slot.slotId, pid: launch.pid, bootId: launch.bootId },
        records: [slotRecord(slot.slotId)],
      });
    }),
  );

interface LaunchEnd {
  readonly reason: LaunchEndReason;
  /** Wall-clock ms. */
  readonly endedAt: number;
  readonly code: number | null;
  readonly signal: string | null;
}

/** Records the end of a recorded launch once; a launch already ended or never recorded is left alone. */
const recordEnd = (store: Store, launchId: string, end: LaunchEnd): Effect.Effect<boolean, StoreError> =>
  Effect.gen(function* () {
    const known = yield* readLaunch(store, launchId);

    if (known === undefined || known.ended_at !== null) {return false;}

    yield* store.change((change) =>
      Effect.gen(function* () {
        yield* change.query(
          `UPDATE launch SET ended_at = ?, end_reason = ?, exit_code = ?, exit_signal = ? WHERE launch_id = ? AND ended_at IS NULL`,
          [end.endedAt, end.reason, end.code, end.signal, launchId],
        );
        yield* change.recordHistory({
          factoryId: known.factory_id,
          kind: "launch.ended",
          subject: launchId,
          detail: { slotId: known.slot_id, reason: end.reason, code: end.code, signal: end.signal },
          records: [slotRecord(known.slot_id)],
        });
      }),
    );

    return true;
  });

const endOf = (launch: LaunchRecord): LaunchEnd | undefined =>
  launch.exit === undefined
    ? undefined
    : {
        reason: launch.exit.requested === true ? "requested" : "exited",
        endedAt: Date.parse(launch.exit.endedAt),
        code: launch.exit.code,
        signal: launch.exit.signal,
      };

/**
 * What scheduling did with one slot.
 *
 * - `started`: the host started its first launch.
 * - `adopted`: the host reports a live launch the daemon had not recorded; it is now the current one.
 * - `running`: its recorded launch is still live.
 * - `ended`: its launch has ended; relaunching is recovery, not scheduling.
 * - `unconfirmed`: ownership is unknown: the host does not know the slot's recorded launch, or a
 *   launch was requested of an earlier host in this boot, which may have left it running.
 * - `duplicate`: the host reports more than one live launch in the slot; nothing is picked or started.
 * - `held`: its condition is not normal; nothing is launched into it.
 * - `stopped`: its factory is stopping or stopped (PRD §10.3); the slot is not touched.
 * - `refused`: the launch could not be built or the host would not start it; the next daemon start tries again.
 */
export type SlotScheduleOutcome =
  | "started"
  | "adopted"
  | "running"
  | "ended"
  | "unconfirmed"
  | "duplicate"
  | "held"
  | "stopped"
  | "refused";

export interface SlotScheduleResult {
  readonly factoryId: string;
  readonly slotId: string;
  readonly outcome: SlotScheduleOutcome;
  readonly launchId?: string;
  /** Why the launch was refused, for `refused`. */
  readonly error?: string;
}

export interface SlotSchedulerOptions {
  readonly store: Store;
  readonly stateRoot: string;
  readonly host: SlotHost;
  /** The host process answering now; its inventory is complete for every launch it started. */
  readonly hostId: string;
  /** The machine boot the host runs in; a recorded launch from another boot is known gone (PRD §10.2). */
  readonly bootId: string;
  /** The pinned Pi, or the test's stub (`FOUNDRY_PI_BIN`). */
  readonly pi: PiExecutable;
  /** Absolute path of the Foundry Pi extension entry point. */
  readonly foundryExtension: string;
  /** The configured slots of the started factories. */
  readonly slots: ReadonlyArray<PlannedSlot>;
  /**
   * Whether a factory may still be assigned new launches; checked per slot, so a factory stop
   * begun mid-schedule launches nothing more in its scope. Default: every factory.
   */
  readonly inScope?: (factoryId: string) => boolean;
}

export interface SlotScheduler {
  /** Reconciles every slot with the host and launches into each vacant, never-launched one. */
  schedule(): Promise<ReadonlyArray<SlotScheduleResult>>;
  /** Records a launch exit the host reported; true when it ended a recorded launch. */
  recordExit(launch: LaunchRecord): Promise<boolean>;
  /** Resolves once scheduling and exit reports queued so far have finished. */
  idle(): Promise<void>;
}

/** Scheduling and exit reports run one at a time, so a slot is never launched into twice. */
export const createSlotScheduler = (options: SlotSchedulerOptions): SlotScheduler => {
  const { store, host } = options;
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const run = tail.then(work);
    tail = run.catch(() => {});

    return run;
  };

  const scheduleSlot = async (slot: PlannedSlot, inventory: ReadonlyArray<LaunchRecord>): Promise<SlotScheduleResult> => {
    const result = (outcome: SlotScheduleOutcome, launchId?: string): SlotScheduleResult =>
      launchId === undefined
        ? { factoryId: slot.factoryId, slotId: slot.slotId, outcome }
        : { factoryId: slot.factoryId, slotId: slot.slotId, outcome, launchId };

    if (options.inScope !== undefined && !options.inScope(slot.factoryId)) {return result("stopped");}

    const row = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));

    if (row !== undefined && row.condition !== "normal") {return result("held");}

    const mine = inventory.filter((launch) => launch.factoryId === slot.factoryId && launch.slotId === slot.slotId);
    const live = mine.filter((launch) => launch.liveness === "live");

    // Never pick one of several: whichever is kept, the other would still be a second worker.
    if (live.length > 1) {return result("duplicate");}

    const [only] = live;

    if (only !== undefined) {
      if (row?.current_launch === only.launchId) {return result("running", only.launchId);}

      // A request pending on this same host whose reply was lost: the live launch is the one we started.
      if (row?.pending_host === options.hostId) {
        await Effect.runPromise(recordLaunch(store, slot, only, "started"));

        return result("started", only.launchId);
      }

      await Effect.runPromise(recordLaunch(store, slot, only, "adopted"));

      return result("adopted", only.launchId);
    }

    const current = row?.current_launch ?? null;

    if (current !== null) {
      const recorded = await Effect.runPromise(readLaunch(store, current));

      if (recorded === undefined || recorded.ended_at !== null) {return result("ended", current);}

      // Not live on the host, and not reported gone (that was recorded above).
      if (recorded.boot_id !== options.bootId) {
        const endedAt = await Effect.runPromise(Clock.currentTimeMillis);
        await Effect.runPromise(recordEnd(store, current, { reason: "machine_restarted", endedAt, code: null, signal: null }));

        return result("ended", current);
      }

      return result("unconfirmed", current);
    }

    // A launch was requested but never recorded: the daemon stopped between the request and its record.
    if (row !== undefined && row.pending_host !== null) {
      if (row.pending_host === options.hostId) {
        // The same host process knows every launch it started; one that has since ended was ours.
        for (const gone of mine) {
          const end = endOf(gone);

          if (end === undefined || (await Effect.runPromise(readLaunch(store, gone.launchId))) !== undefined) {continue;}

          await Effect.runPromise(recordLaunch(store, slot, gone, "started"));
          await Effect.runPromise(recordEnd(store, gone.launchId, end));

          return result("ended", gone.launchId);
        }
      } else if (row.pending_boot === options.bootId) {
        // An earlier host in this boot may have started it, and its process group may still run.
        return result("unconfirmed");
      }
      // Otherwise the machine restarted since the request, which proves any launch gone (PRD §10.2).
    }

    // Host-confirmed vacant and never launched: the slot's first launch.
    let args;

    try {
      const slotDir = slotDirectory(options.stateRoot, slot.factoryId, slot.slotId);
      mkdirSync(slotDir, { recursive: true, mode: 0o700 });

      args = buildLaunchArgs(
        {
          model: slot.station.model,
          skills: slot.station.skills,
          extensions: slot.station.extensions,
          foundryExtension: options.foundryExtension,
          slotDir,
          factoryId: slot.factoryId,
          slotId: slot.slotId,
        },
        options.pi,
      );
    } catch (cause) {
      return { ...result("refused"), error: messageOf(cause) };
    }

    await Effect.runPromise(recordRequested(store, slot, { hostId: options.hostId, bootId: options.bootId }));
    let launched: LaunchRecord;

    try {
      // The worker dials the instance's channel socket; the host adds the launch identity itself.
      launched = await host.launch({
        factoryId: slot.factoryId,
        slotId: slot.slotId,
        ...args,
        env: { [CHANNEL_SOCKET_ENV]: channelSocketPath(options.stateRoot) },
      });
    } catch (cause) {
      // A refusal proves nothing started. Any other failure (a timeout, a lost connection) may hide a
      // started launch, so the request stays pending and the next start settles it from the host.
      if (cause instanceof HostRefusedError) {await Effect.runPromise(recordRefused(store, slot, cause.reason));}

      return { ...result("refused"), error: messageOf(cause) };
    }

    await Effect.runPromise(recordLaunch(store, slot, launched, "started"));

    return result("started", launched.launchId);
  };

  const recordGone = async (launch: LaunchRecord): Promise<boolean> => {
    const end = endOf(launch);

    return end === undefined ? false : Effect.runPromise(recordEnd(store, launch.launchId, end));
  };

  return {
    schedule: () =>
      serial(async () => {
        const inventory = await host.inventory();

        // Ends the host reported while no daemon was listening.
        for (const launch of inventory) {
          if (launch.liveness === "gone") {await recordGone(launch);}
        }

        const results: Array<SlotScheduleResult> = [];

        for (const slot of options.slots) {results.push(await scheduleSlot(slot, inventory));}

        return results;
      }),
    recordExit: (launch) => serial(() => recordGone(launch)),
    idle: () => serial(async () => {}),
  };
};

/**
 * Dials the instance's Worker Host, starting one if none answers (PRD §3.2). Callers must hold the
 * state-root claim, so only one starter races for the host socket.
 */
export const connectOrStartHost = async (stateRoot: string): Promise<HostConnection> => {
  try {
    return await connectHost(stateRoot);
  } catch (cause) {
    // Only "nobody answers" means start one; anything else is a real failure to report.
    const code = codeOf(cause);

    if (code !== "ENOENT" && code !== "ECONNREFUSED") {throw cause;}

    await startHost(stateRoot);

    return connectHost(stateRoot);
  }
};

export { SlotsError, type SlotInterrupter, type SlotsErrorCode, type SlotsReader } from "./slots-error.js";

const iso = (ms: number): string => new Date(ms).toISOString();

const decodeCondition = Schema.decodeUnknownSync(SlotCondition);

const toLaunch = (row: LaunchRow): SlotLaunch => ({
  launchId: row.launch_id,
  bootId: row.boot_id,
  pid: row.pid,
  startedAt: iso(row.started_at),
  origin: row.origin,
  endedAt: row.ended_at === null ? null : iso(row.ended_at),
  endReason: row.end_reason,
  exitCode: row.exit_code,
  exitSignal: row.exit_signal,
});

/** The slot as it stands in the store: its condition and its current launch. */
const summaryOf = async (store: Store, slot: PlannedSlot): Promise<SlotSummary> => {
  const row = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));
  const current = row?.current_launch ?? null;
  const launch = current === null ? undefined : await Effect.runPromise(readLaunch(store, current));

  return {
    factoryId: slot.factoryId,
    slotId: slot.slotId,
    station: slot.station.address,
    ordinal: slot.ordinal,
    // Read as stored: a condition this build does not serve yet fails loudly, not as `normal`.
    condition: row === undefined ? "normal" : decodeCondition(row.condition),
    launch: launch === undefined ? null : toLaunch(launch),
  };
};

/** The named factory, or the only one loaded; refuses with `SlotsError` otherwise. */
const resolveFactory = (factories: ReadonlyArray<string>, factory: string | undefined): string => {
  if (factory !== undefined) {
    if (!factories.includes(factory)) {throw new SlotsError("unknown_factory", `No factory "${factory}" is loaded`);}

    return factory;
  }

  const [only] = factories;

  if (factories.length === 1 && only !== undefined) {return only;}

  throw new SlotsError(
    "factory_required",
    factories.length === 0 ? "No factory is loaded" : "More than one factory is loaded; name one with --factory",
  );
};

/** The configured slot a request names; refuses with `SlotsError` when there is none. */
const findSlot = (
  factories: ReadonlyArray<string>,
  slots: ReadonlyArray<PlannedSlot>,
  slotId: string,
  factory: string | undefined,
): PlannedSlot => {
  const factoryId = resolveFactory(factories, factory);
  const slot = slots.find((s) => s.factoryId === factoryId && s.slotId === slotId);

  if (slot === undefined) {throw new SlotsError("slot_not_found", `No slot ${slotId} in factory "${factoryId}"`);}

  return slot;
};

/**
 * Serves the configured slots of the started factories from the store, read afresh on each
 * request. Configuration is read only at start, so `slots` is fixed for the run.
 */
export const storeSlotsReader = (
  store: Store,
  stateRoot: string,
  factories: ReadonlyArray<string>,
  slots: ReadonlyArray<PlannedSlot>,
): SlotsReader => ({
  list: async (factory) => {
    if (factory !== undefined) {resolveFactory(factories, factory);}

    const listed: Array<SlotSummary> = [];

    for (const slot of slots) {
      if (factory === undefined || slot.factoryId === factory) {listed.push(await summaryOf(store, slot));}
    }

    return { slots: listed };
  },
  show: async (slotId, factory) => {
    const slot = findSlot(factories, slots, slotId, factory);

    const rows = await Effect.runPromise(
      store.read<LaunchRow>(
        `SELECT ${LAUNCH_COLUMNS} FROM launch WHERE factory_id = ? AND slot_id = ? ORDER BY started_at, rowid`,
        [slot.factoryId, slotId],
      ),
    );

    const launches = rows.map((row): SlotLaunchHistoryEntry => {
      const stderr = launchStderrPath(stateRoot, row.launch_id);

      return { ...toLaunch(row), stderrPath: existsSync(stderr) ? stderr : null };
    });

    return { slot: await summaryOf(store, slot), launches };
  },
});

/** The worker channel's interrupt; a `ChannelServer` satisfies it. */
export type SlotChannel = Pick<ChannelServer, "interrupt">;

export interface SlotInterrupterOptions {
  readonly store: Store;
  readonly factories: ReadonlyArray<string>;
  readonly slots: ReadonlyArray<PlannedSlot>;
  readonly channel: SlotChannel;
  /** Defaults to `SLOT_INTERRUPT_ACK_TIMEOUT_MS`. */
  readonly ackTimeoutMs?: number;
}

/**
 * Interrupts a slot's worker (PRD §5.3) through the authenticated channel's interrupt: the run is
 * aborted, the launch and conversation are kept. Nothing is recorded and nothing is launched or
 * terminated; a worker that does not answer is refused, never restarted.
 */
export const storeSlotInterrupter = (options: SlotInterrupterOptions): SlotInterrupter => {
  const ackTimeoutMs = options.ackTimeoutMs ?? SLOT_INTERRUPT_ACK_TIMEOUT_MS;

  return {
    interrupt: async (slotId, factory) => {
      const slot = findSlot(options.factories, options.slots, slotId, factory);
      const launch = (await summaryOf(options.store, slot)).launch;

      if (launch === null || launch.endedAt !== null) {
        throw new SlotsError("no_live_launch", `Slot ${slotId} has no live launch to interrupt`);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SlotsError("interrupt_unacknowledged", `The worker on launch ${launch.launchId} did not acknowledge the interrupt within ${ackTimeoutMs} ms`)),
          ackTimeoutMs,
        );
      });

      let outcome;

      try {
        outcome = await Promise.race([options.channel.interrupt(launch.launchId), timedOut]);
      } catch (error) {
        if (error instanceof ChannelUnavailableError) {throw new SlotsError("channel_unavailable", `Slot ${slotId}: ${error.message}`);}

        throw error;
      } finally {
        clearTimeout(timer);
      }

      return { launchId: launch.launchId, outcome, slot: await summaryOf(options.store, slot) };
    },
  };
};
