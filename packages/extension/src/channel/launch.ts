/** Launch lifetime is longer than a Pi extension instance: /reload reconstructs the latter. */
import type { HelloRejectReason } from "@foundry/protocol";

interface LaunchState {
  reason: HelloRejectReason | undefined;
  owner: symbol;
  stop: (() => void) | undefined;
}

// Pi may reload this module too. Keep only live-launch metadata on this process, never on disk.
// A worker process normally has one entry; in-process SDK fixtures may own independent launches.
const registryKey = Symbol.for("foundry.worker.launch-channels.v1");

// SAFETY: this private versioned symbol is written only here, always with this launch registry type.
const scopedProcess = process as NodeJS.Process & { [registryKey]?: Map<string, LaunchState> };
const states = scopedProcess[registryKey] ??= new Map<string, LaunchState>();

/** Acquire transport ownership without clearing a previous instance's terminal refusal. */
export const claimLaunchChannel = (key: string) => {
  const previous = states.get(key);
  previous?.stop?.();
  const owner = Symbol();
  const state: LaunchState = previous ?? { reason: undefined, owner, stop: undefined };
  state.owner = owner;
  state.stop = undefined;
  states.set(key, state);

  const current = (): boolean => states.get(key) === state && state.owner === owner;

  return {
    get reason(): HelloRejectReason | undefined { return state.reason; },
    refuse(reason: HelloRejectReason): void {
      if (current() && reason.kind === "terminal") {state.reason ??= reason;}
    },
    own(stop: () => void): void {
      if (!current()) {
        stop();

        return;
      }

      state.stop = stop;
    },
    release(quit: boolean): void {
      if (!current()) {return;}

      state.stop?.();
      state.stop = undefined;

      // Only terminal metadata must bridge reload/new/resume/fork. Quit ends the launch scope.
      if (quit || state.reason === undefined) {states.delete(key);}
    },
  };
};
