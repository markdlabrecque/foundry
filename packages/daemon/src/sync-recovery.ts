/**
 * Reconciling a source sync interrupted by a crash (PRD §10.2, "Interrupted operations"). A sync
 * is never rerun automatically and recovery never fetches: it reads only the clone and the intent
 * the sync recorded before it merged (`recordedHead`, `fetchedHead`; see factory-sync.ts).
 *
 * - The fetched commit is already an ancestor of the default branch: the sync landed, so it is
 *   recorded complete, a merge that landed but was never cleaned up is quit, and the sync-conflict
 *   and interrupted-sync holds close as after any sync that records a result.
 * - Otherwise: any half-finished merge is aborted, the default branch is restored to the recorded
 *   head (only if it still points there: a branch that moved is indeterminate and is never reset),
 *   and the sync is recorded interrupted, with an interrupted-sync hold showing both heads
 *   for the operator to run the sync again. The next sync that records a result resolves the hold.
 *
 * Either verdict reopens the factory's queue, unless another of its operations still awaits
 * recovery. If the clone cannot be restored, nothing is recorded and the queue stays closed.
 */
import { Data, Effect, Schema } from "effect";
import { messageOf } from "@foundry/protocol/errors";
import { runCloneGit } from "./factory-clone.js";
import { closeOpenHoldIn, raiseHoldIn } from "./holds.js";
import { listOperationsAwaitingRecovery, recordRecoveryResultIn } from "./operations.js";
import type { Operation } from "./operations.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Store, StoreError } from "./store.js";

/** The clone an interrupted sync ran in. */
export interface SyncRecoveryTarget {
  readonly clonePath: string;
  readonly defaultBranch: string;
}

export interface RecoveredSync {
  readonly operation: Operation;
  /** `complete`: the fetched commit had landed. `interrupted`: the recorded head was restored. */
  readonly verdict: "complete" | "interrupted";
}

/** The clone could not be inspected or restored; the sync still awaits recovery. */
export class SyncRecoveryError extends Data.TaggedError("SyncRecoveryError")<{
  readonly operationId: number;
  readonly message: string;
}> {}

/** No hooks: the operator's configured hooks are not Foundry's. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

const isText = Schema.is(Schema.NonEmptyString);

/**
 * Reconciles every interrupted sync of `factoryId` that awaits recovery, oldest first. Other
 * operation kinds are left to their own recovery. Never contacts the source.
 */
export const recoverInterruptedSyncs = (
  store: Store,
  factoryId: string,
  target: SyncRecoveryTarget,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ReadonlyArray<RecoveredSync>, StoreError | SyncRecoveryError> =>
  Effect.gen(function* () {
    const awaiting = yield* listOperationsAwaitingRecovery(store, factoryId);
    const recovered: Array<RecoveredSync> = [];

    for (const operation of awaiting) {
      if (operation.kind === "sync") {recovered.push(yield* recoverSync(store, operation, target, env));}
    }

    return recovered;
  });

const recoverSync = (
  store: Store,
  operation: Operation,
  target: SyncRecoveryTarget,
  env: NodeJS.ProcessEnv,
): Effect.Effect<RecoveredSync, StoreError | SyncRecoveryError> =>
  Effect.gen(function* () {
    const clone = target.clonePath;
    const recordedBranch = operation.intent["defaultBranch"];
    const branch = isText(recordedBranch) ? recordedBranch : target.defaultBranch;
    const recordedHead = isText(operation.intent["recordedHead"]) ? operation.intent["recordedHead"] : null;
    const fetchedHead = isText(operation.intent["fetchedHead"]) ? operation.intent["fetchedHead"] : null;

    const git = (args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => runCloneGit(args, env, clone),
        catch: (cause) => new SyncRecoveryError({ operationId: operation.id, message: `git ${args.join(" ")}: ${messageOf(cause)}` }),
      });

    // A failed probe means "no": a missing commit is not an ancestor, a missing ref is not a merge.
    const succeeds = (args: ReadonlyArray<string>) =>
      Effect.promise(() => runCloneGit(args, env, clone).then(() => true, () => false));

    const branchRef = `refs/heads/${branch}`;
    const hold = { factoryId: operation.factoryId, subject: operation.factoryId } as const;

    const mergeInProgress = succeeds(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]);

    if (fetchedHead !== null && (yield* succeeds(["merge-base", "--is-ancestor", fetchedHead, branchRef]))) {
      // The merge landed but died before cleaning up; left in place, every later sync would fail.
      if (yield* mergeInProgress) {yield* git([...NO_HOOKS, "merge", "--quit"]);}

      const head = yield* git(["rev-parse", "--verify", `${branchRef}^{commit}`]);

      const done = yield* store.change((change) =>
        Effect.gen(function* () {
          const recorded = yield* recordRecoveryResultIn(change, operation.id, {
            status: "complete",
            result: { previousHead: recordedHead, fetchedHead, head, recovered: true },
          });

          yield* closeOpenHoldIn(change, { ...hold, kind: "sync_conflict" }, "cleared");
          // A sync the operator ran again landed: that answers any earlier interrupted sync.
          yield* closeOpenHoldIn(change, { ...hold, kind: "interrupted_sync" }, "resolved");

          return recorded;
        }),
      );

      return { operation: done, verdict: "complete" } as const;
    }

    // The merge starts only after both heads are recorded, so without them nothing was merged.
    let abortedMerge = false;
    let head: string | null = null;

    if (recordedHead !== null) {
      // The merge only ever moves the branch to the fetched commit, so any other head is not ours
      // to discard (PRD §10.2): leave it, record nothing and keep the queue closed.
      const current = yield* git(["rev-parse", "--verify", `${branchRef}^{commit}`]);

      if (current !== recordedHead) {
        return yield* new SyncRecoveryError({
          operationId: operation.id,
          message: `${branch} is at ${current}, not the recorded head ${recordedHead}; not resetting it`,
        });
      }

      if (yield* mergeInProgress) {
        // A failed abort does not block recovery: the hard reset below removes MERGE_HEAD too.
        abortedMerge = yield* succeeds([...NO_HOOKS, "merge", "--abort"]);
      }

      yield* git([...NO_HOOKS, "switch", "--quiet", "--discard-changes", "--no-guess", "--no-recurse-submodules", "--", branch]);
      yield* git([...NO_HOOKS, "reset", "--hard", "--quiet", recordedHead]);
      head = yield* git(["rev-parse", "--verify", `${branchRef}^{commit}`]);
    }

    const done = yield* store.change((change) =>
      Effect.gen(function* () {
        const recorded = yield* recordRecoveryResultIn(change, operation.id, {
          status: "interrupted",
          result: { previousHead: recordedHead, fetchedHead, head, abortedMerge },
        });

        yield* raiseHoldIn(change, {
          ...hold,
          kind: "interrupted_sync",
          evidence: { operationId: operation.id, recordedHead, fetchedHead },
        });

        return recorded;
      }),
    );

    return { operation: done, verdict: "interrupted" } as const;
  });
