/**
 * PRD §10.2 step 3: after a daemon restart, each started factory reconciles its interrupted
 * operations, and only then reopens its integration and sync queue.
 *
 * Each factory runs its recovery steps in order, then waits until none of its operations awaits
 * recovery (re-read after every commit, so a kind recovered in the background, like `after_create`,
 * counts once its verdict commits), then resumes its queue. Factories recover independently, so a
 * stuck recovery holds only its own factory's queue. Nothing else waits here: workers keep running,
 * channels are accepted, and assignment reads each ticket's own readiness instead.
 *
 * A step that fails is reported and the next one still runs. An operation left awaiting recovery
 * keeps that factory's queue closed, as `startNextOperation` would anyway.
 */
import { Effect } from "effect";
import { listOperationsAwaitingRecovery } from "./operations.js";
import type { Operation } from "./operations.js";
import type { Store } from "./store.js";

/** One kind's recovery for a factory. Resolves once that kind's interrupted operations are settled. */
export interface RecoveryStep {
  readonly kind: string;
  readonly recover: (factoryId: string, signal: AbortSignal) => Promise<void>;
}

export interface FactoryRecoveryOptions {
  readonly store: Store;
  readonly factories: ReadonlyArray<string>;
  /** Run in order for each factory. Another kind's recovery is one more entry. */
  readonly steps: ReadonlyArray<RecoveryStep>;
  /** Runs once nothing of the factory awaits recovery. Not run after `stop`. */
  readonly onRecovered: (factoryId: string) => Promise<void> | void;
  /** After the steps, operations still awaiting recovery, so the queue keeps waiting. */
  readonly onWaiting?: (factoryId: string, awaiting: ReadonlyArray<Operation>) => void;
  /** `kind` is the step's kind, `awaiting` for the re-read or `resume` for `onRecovered`. Not called after `stop`. */
  readonly onError: (factoryId: string, kind: string, cause: unknown) => void;
}

export interface FactoryRecovery {
  /** Aborts the steps and any wait, and settles once every factory's run has. */
  readonly stop: () => Promise<void>;
}

/** Resolves once nothing of `factoryId` awaits recovery, or when `signal` aborts. */
const untilRecovered = (options: FactoryRecoveryOptions, factoryId: string, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    let checking = false;
    let dirty = false;
    let reported = false;
    // Commits arrive asynchronously, so the listener never runs before `check` is defined.
    const unsubscribe = options.store.onCommit(() => { void check(); });

    const done = (): void => {
      unsubscribe();
      signal.removeEventListener("abort", done);
      resolve();
    };

    const check = async (): Promise<void> => {
      dirty = true;

      if (checking) {return;}

      checking = true;

      try {
        while (dirty && !signal.aborted) {
          dirty = false;

          try {
            const awaiting = await Effect.runPromise(listOperationsAwaitingRecovery(options.store, factoryId));

            if (awaiting.length === 0) {
              done();

              return;
            }

            if (!reported) {
              reported = true;
              options.onWaiting?.(factoryId, awaiting);
            }
          } catch (error) {
            if (!signal.aborted) {options.onError(factoryId, "awaiting", error);}
          }
        }
      } finally {
        checking = false;
      }
    };

    signal.addEventListener("abort", done);
    void check();
  });

/** Starts every factory's recovery in the background. */
export const startFactoryRecovery = (options: FactoryRecoveryOptions): FactoryRecovery => {
  const controller = new AbortController();
  const { signal } = controller;

  const recover = async (factoryId: string): Promise<void> => {
    for (const step of options.steps) {
      if (signal.aborted) {return;}

      try {
        await step.recover(factoryId, signal);
      } catch (error) {
        if (!signal.aborted) {options.onError(factoryId, step.kind, error);}
      }
    }

    await untilRecovered(options, factoryId, signal);

    if (signal.aborted) {return;}

    try {
      await options.onRecovered(factoryId);
    } catch (error) {
      if (!signal.aborted) {options.onError(factoryId, "resume", error);}
    }
  };

  const runs = options.factories.map(recover);

  return {
    stop: async () => {
      controller.abort();
      await Promise.all(runs);
    },
  };
};
