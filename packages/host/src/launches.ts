/**
 * The Worker Host's launch registry: starts each launch in its own process
 * group, owns it as the parent, and reports what it knows about every launch.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Environment variables through which a launch learns its identity (PRD §3.2). */
export const LAUNCH_ENV = {
  factoryId: "FOUNDRY_FACTORY_ID",
  slotId: "FOUNDRY_SLOT_ID",
  launchId: "FOUNDRY_LAUNCH_ID",
} as const;

/** What the daemon asks the host to start in a slot. */
export interface LaunchSpec {
  readonly factoryId: string;
  readonly slotId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Added to the host's full environment, after which the identity variables are set. */
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

export interface LaunchRegistry {
  /** Starts `spec` unless its slot already holds a live launch. */
  launch(spec: LaunchSpec): Promise<LaunchRecord>;
  /** Every launch this host has started, oldest first. */
  inventory(): LaunchRecord[];
}

export function createLaunchRegistry(options: {
  readonly bootId: string;
  readonly onExit: (record: LaunchRecord) => void;
}): LaunchRegistry {
  const launches = new Map<string, LaunchRecord>();
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
        occupied.delete(key);
        options.onExit(ended);
      });

      return started;
    },
    inventory() {
      return [...launches.values()];
    },
  };
}
