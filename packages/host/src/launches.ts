/**
 * The Worker Host's launch registry: starts each launch in its own process
 * group, owns it as the parent, and reports what it knows about every launch.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { LAUNCH_ENV } from "./launch-command.js";
import { terminateGroup, type GroupSignal, type GroupTermination } from "./terminate.js";

/** What the daemon asks the host to start in a slot. */
export interface LaunchSpec {
  readonly factoryId: string;
  readonly slotId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Added to the host's full environment. The host then sets the identity
   * variables (`LAUNCH_ENV`) itself, overriding any given here, and generates
   * the launch ID; a caller cannot choose either.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface LaunchExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly endedAt: string;
}

/**
 * One launch as the host knows it. `live` means the host, as the launch's
 * parent, has not seen it exit; `gone` means it has, and `exit` says how.
 */
export type LaunchRecord = {
  readonly launchId: string;
  readonly factoryId: string;
  readonly slotId: string;
  readonly pid: number;
  /** The launch's own process group; equal to `pid`. */
  readonly pgid: number;
  readonly bootId: string;
  readonly startedAt: string;
} & (
  | { readonly liveness: "live"; readonly exit?: undefined }
  | { readonly liveness: "gone"; readonly exit: LaunchExit }
);

export class LaunchRefused extends Error {}

/** Refusal to terminate: the host does not own the named launch in this boot. */
export class TerminateRefused extends Error {}

export interface TerminateOptions {
  /** Time between SIGTERM and SIGKILL. 0 skips SIGTERM. Default 5 s. */
  readonly graceMs?: number;
  /** How long to wait for the group to vanish after SIGKILL. Default 5 s. */
  readonly killWaitMs?: number;
}

/**
 * The result of terminating a launch's process group. `gone` is positive:
 * the host reaped the leader and no process is left in the group. Anything
 * short of that is `unconfirmed`, never success.
 */
export interface Termination extends GroupTermination {
  readonly launch: LaunchRecord;
}

export const DEFAULT_TERMINATE_GRACE_MS = 5_000;
export const DEFAULT_TERMINATE_KILL_WAIT_MS = 5_000;

export interface LaunchRegistry {
  /** Starts `spec` unless its slot already holds a live launch. */
  launch(spec: LaunchSpec): Promise<LaunchRecord>;
  /** Every launch this host has started, oldest first. */
  inventory(): LaunchRecord[];
  /**
   * Terminates the process group of launch `launchId`, which this host must
   * have started in this boot; refuses anything else. Concurrent calls for
   * one launch share a single termination.
   */
  terminate(launchId: string, options?: TerminateOptions): Promise<Termination>;
}

export function createLaunchRegistry(options: {
  readonly bootId: string;
  readonly onExit: (record: LaunchRecord) => void;
  /** Signals a process group; injected only by tests. Default `process.kill(-pgid, signal)`. */
  readonly signalGroup?: (pgid: number, signal: GroupSignal) => boolean;
}): LaunchRegistry {
  const launches = new Map<string, LaunchRecord>();
  /** Group IDs the host has seen empty after the leader's exit; never signalled again, since the ID may be reused. */
  const emptyGroups = new Set<string>();
  const terminations = new Map<string, Promise<Termination>>();
  const signalGroup = options.signalGroup ?? signalProcessGroup;
  const slotKey = (factoryId: string, slotId: string): string => JSON.stringify([factoryId, slotId]);
  /** Slots with a launch that is starting or live; checked and set without awaiting, so starts serialize. */
  const occupied = new Set<string>();

  return {
    async launch(spec) {
      const key = slotKey(spec.factoryId, spec.slotId);
      if (occupied.has(key)) {
        throw new LaunchRefused(`slot ${spec.slotId} of factory ${spec.factoryId} already holds a live launch`);
      }
      occupied.add(key);

      const launchId = randomUUID();
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...spec.env,
          [LAUNCH_ENV.factoryId]: spec.factoryId,
          [LAUNCH_ENV.slotId]: spec.slotId,
          [LAUNCH_ENV.launchId]: launchId,
        },
        // Its own session and process group, so it is stoppable as a group
        // and outlives nothing but the host's own decisions.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => {
            child.off("error", reject);
            resolve();
          });
          child.once("error", reject);
        });
      } catch (error) {
        occupied.delete(key);
        throw new LaunchRefused(`launch failed to start: ${(error as Error).message}`);
      }

      // A later ChildProcess error (for example a failed kill) must not crash the host.
      child.on("error", () => {});

      const pid = child.pid as number;
      const started: LaunchRecord = {
        launchId,
        factoryId: spec.factoryId,
        slotId: spec.slotId,
        pid,
        pgid: pid,
        bootId: options.bootId,
        startedAt: new Date().toISOString(),
        liveness: "live",
      };
      launches.set(launchId, started);

      // Hold stdin open for the launch's lifetime; drain stdout and stderr
      // without keeping them, so the launch never blocks on a full pipe.
      child.stdin.on("error", () => {});
      child.stdout.on("error", () => {}).resume();
      child.stderr.on("error", () => {}).resume();

      child.once("exit", (code, signal) => {
        child.stdin.destroy();
        const ended: LaunchRecord = {
          ...started,
          liveness: "gone",
          exit: { code, signal, endedAt: new Date().toISOString() },
        };
        launches.set(launchId, ended);
        // Learn now, while the ID cannot yet have been reused, whether the
        // group emptied with its leader.
        if (!signalGroup(pid, 0)) emptyGroups.add(launchId);
        occupied.delete(key);
        options.onExit(ended);
      });

      return started;
    },
    inventory() {
      return [...launches.values()];
    },
    terminate(launchId, terminateOptions = {}) {
      const record = launches.get(launchId);
      if (record === undefined) {
        return Promise.reject(new TerminateRefused(`launch ${launchId} is not owned by this host`));
      }
      if (record.bootId !== options.bootId) {
        return Promise.reject(new TerminateRefused(`launch ${launchId} belongs to an earlier boot`));
      }
      const running = terminations.get(launchId);
      if (running !== undefined) return running;

      const leaderReaped = (): boolean => launches.get(launchId)?.liveness === "gone";
      const termination = (async (): Promise<Termination> => {
        if (emptyGroups.has(launchId)) {
          return { outcome: "gone", escalated: false, launch: launches.get(launchId) as LaunchRecord };
        }
        const result = await terminateGroup(
          record.pgid,
          {
            graceMs: terminateOptions.graceMs ?? DEFAULT_TERMINATE_GRACE_MS,
            killWaitMs: terminateOptions.killWaitMs ?? DEFAULT_TERMINATE_KILL_WAIT_MS,
          },
          { signalGroup, leaderReaped },
        );
        if (result.outcome === "gone") emptyGroups.add(launchId);
        return { ...result, launch: launches.get(launchId) as LaunchRecord };
      })().finally(() => terminations.delete(launchId));
      terminations.set(launchId, termination);
      return termination;
    },
  };
}

/** `kill(-pgid, signal)`; false when the group has no process left. */
function signalProcessGroup(pgid: number, signal: GroupSignal): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM: a process remains that the host may not signal; the group is not gone.
    return true;
  }
}
