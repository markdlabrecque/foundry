/**
 * Whole-instance shutdown (PRD §10.3): `foundry shutdown [--force]`.
 *
 * Every started factory not already stopped is stopped with the scoped factory stop, all at once,
 * so each one drains, terminates and confirms its own process groups exactly as `factory stop`
 * does. Any launch the host still owns outside those factories (a factory refused or not loaded in
 * this run) is then terminated the same way. Only when every owned group is confirmed gone is the
 * Worker Host asked to stop; the host itself refuses while any slot is not confirmed empty.
 *
 * A factory that fails to confirm fails the whole shutdown: the host keeps running, the failed
 * factory stays `stopping` with its slots holding their launches, and the shutdown may be retried.
 * Recoverable state is never deleted here; whatever was interrupted is left to recovery (§10.2).
 */
import { messageOf } from "@foundry/protocol/errors";
import type { FactoryStopResult } from "@foundry/protocol/factories-api";
import type { ShutdownResult } from "@foundry/protocol/shutdown-api";
import type { LaunchRecord, TerminateOptions, Termination } from "@foundry/host";
import { DEFAULT_STOP_GRACE_MS, DEFAULT_STOP_KILL_WAIT_MS } from "./factory-stop.js";
import type { FactoryStates, FactoryStopper } from "./factory-stop.js";

export type ShutdownErrorCode = "shutdown_unconfirmed";

/** A shutdown that could not confirm every owned group gone, or whose host refused to stop. */
export class ShutdownError extends Error {
  override readonly name = "ShutdownError";
  constructor(
    readonly code: ShutdownErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a shutdown needs from the Worker Host; a `HostConnection` satisfies it. */
export interface ShutdownHost {
  inventory(): Promise<ReadonlyArray<LaunchRecord>>;
  terminate(launchId: string, options?: TerminateOptions): Promise<Termination>;
  shutdown(): Promise<void>;
}

export interface InstanceShutdownOptions {
  readonly stopper: FactoryStopper;
  readonly states: FactoryStates;
  /** The factories started in this run. */
  readonly factories: ReadonlyArray<string>;
  /** The Worker Host to stop, or `undefined` when none answers. Asked once per shutdown attempt. */
  readonly host: () => Promise<ShutdownHost | undefined>;
  readonly graceMs?: number;
  readonly killWaitMs?: number;
}

export interface InstanceShutdown {
  /**
   * Stops every factory and then the Worker Host. Resolves only once every owned process group is
   * confirmed gone and the host accepted the stop. A shutdown already under way is joined.
   */
  shutdown(force: boolean): Promise<ShutdownResult>;
}

export const createInstanceShutdown = (options: InstanceShutdownOptions): InstanceShutdown => {
  const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_STOP_KILL_WAIT_MS;
  let underway: Promise<ShutdownResult> | undefined;

  const run = async (force: boolean): Promise<ShutdownResult> => {
    const targets = options.factories.filter((factoryId) => options.states.get(factoryId) !== "stopped");
    const stops = await Promise.allSettled(targets.map((factoryId) => options.stopper.stop(factoryId, force)));
    const problems: Array<string> = [];
    const stopped: Array<FactoryStopResult> = [];

    for (const [index, stop] of stops.entries()) {
      if (stop.status === "fulfilled") {stopped.push(stop.value);}
      else {problems.push(`factory "${targets[index] ?? "?"}": ${messageOf(stop.reason)}`);}
    }

    // The host is never stopped while a factory's groups are unconfirmed.
    if (problems.length > 0) {
      throw new ShutdownError("shutdown_unconfirmed", `shutdown did not complete; the worker host keeps running: ${problems.join("; ")}`);
    }

    const host = await options.host();

    if (host === undefined) {return { force, factories: stopped, hostStopped: false };}

    // Launches of factories not started in this run are still owned groups the host must not leave.
    const started = new Set(options.factories);
    const strays = (await host.inventory()).filter((launch) => !started.has(launch.factoryId));

    const ends = await Promise.allSettled(
      strays.map((launch) => host.terminate(launch.launchId, { graceMs: force ? 0 : graceMs, killWaitMs })),
    );

    for (const [index, end] of ends.entries()) {
      const launch = strays[index];

      if (launch === undefined) {continue;}

      if (end.status === "rejected") {problems.push(`${launch.factoryId}/${launch.slotId}: launch ${launch.launchId} was not terminated: ${messageOf(end.reason)}`);}
      else if (end.value.outcome !== "gone") {problems.push(`${launch.factoryId}/${launch.slotId}: the process group of launch ${launch.launchId} could not be confirmed gone`);}
    }

    if (problems.length > 0) {
      throw new ShutdownError("shutdown_unconfirmed", `shutdown did not complete; the worker host keeps running: ${problems.join("; ")}`);
    }

    try {
      await host.shutdown();
    } catch (error) {
      throw new ShutdownError("shutdown_unconfirmed", `the worker host did not stop: ${messageOf(error)}`);
    }

    return { force, factories: stopped, hostStopped: true };
  };

  return {
    shutdown: (force) => {
      underway ??= run(force).catch((cause: unknown) => {
        underway = undefined;
        throw cause;
      });

      return underway;
    },
  };
};
