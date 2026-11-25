/**
 * Recovery of interrupted cleanups and their before_remove runs (PRD §10.2 step 3: "Cleanup and
 * `before_remove`. Rerun. An already-removed worktree or already-deleted branch counts as done").
 *
 * - Worktree directory still present: the cleanup reruns from the start through the cleanup
 *   service, so before_remove runs again and every safety check applies again.
 * - Worktree directory already gone: the removal happened, so the daemon finishes only what the
 *   recorded intent names. It drops that worktree's stale registration, then deletes the recorded
 *   branch unless it holds commits outside the default branch and the cleanup was not forced. An
 *   already-deleted branch counts as done. Nothing else in the clone is touched.
 *
 * Each interrupted operation gets a recovery result, so the factory's queue reopens.
 */
import { lstat } from "node:fs/promises";
import { codeOf, messageOf } from "@foundry/protocol/errors";
import { Effect, Option, Result, Schema } from "effect";
import { runCloneGit } from "./factory-clone.js";
import type { LoadedFactory } from "./factory-loads.js";
import { ticketRecord } from "./history-records.js";
import { closeOpenHoldIn } from "./holds.js";
import { getOperation, listOperationsAwaitingRecovery, recordRecoveryResultIn } from "./operations.js";
import type { Operation } from "./operations.js";
import type { Store, StoreError } from "./store.js";
import type { WorktreeService } from "./worktree-cleanup.js";

export interface CleanupRecoveryOptions {
  readonly store: Store;
  readonly target: (factoryId: string) => { readonly factory: LoadedFactory; readonly clonePath: string } | undefined;
  readonly worktrees: Pick<WorktreeService, "rerun">;
  readonly env?: NodeJS.ProcessEnv;
}

/** How one interrupted cleanup was reconciled. */
export interface CleanupRecovery {
  readonly operationId: number;
  readonly ticket: number | null;
  readonly outcome: "finished" | "rerun" | "failed";
  readonly reason?: string;
}

/** The intent `clean` records before any Git action. */
const CleanupIntent = Schema.Struct({
  path: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  clonePath: Schema.NonEmptyString,
  force: Schema.Boolean,
});

type CleanupIntent = typeof CleanupIntent.Type;

const decodeIntent = Schema.decodeUnknownOption(CleanupIntent);

const isBeforeRemove = (operation: Operation) => operation.kind === "hook" && operation.intent["hook"] === "before_remove";

/** `true` when nothing exists at `path`; any other inspection failure is not proof of removal. */
const absent = (path: string) => Effect.tryPromise({
  try: async () => {
    try {
      await lstat(path);

      return false;
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") {return true;}

      throw cause;
    }
  },
  catch: (cause) => new Error(`cannot inspect ${JSON.stringify(path)}: ${messageOf(cause)}`),
});

/** Completes a removal whose worktree directory is already gone. Fails, changing nothing further, on doubt. */
const finishRemoval = (options: CleanupRecoveryOptions, intent: CleanupIntent, defaultBranch: string) => Effect.gen(function* () {
  const env = options.env ?? process.env;
  const { path, branch } = intent;

  const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(["-c", "core.hooksPath=/dev/null", ...args], env, intent.clonePath),
    catch: (cause) => new Error(messageOf(cause)),
  });

  // Only the recorded worktree's registration, and only while its directory is gone.
  const registrations = yield* git(["worktree", "list", "--porcelain"]);
  const listed = registrations.split("\n\n").some((entry) => entry.split("\n").includes(`worktree ${path}`));

  if (listed) {yield* git(["worktree", "remove", "--force", "--", path]);}

  const tip = yield* git(["for-each-ref", "--format=%(objectname)", "--", `refs/heads/${branch}`]);
  const branchAlreadyDeleted = tip === "";

  if (!branchAlreadyDeleted) {
    const unmerged = Number(yield* git(["rev-list", "--count", `refs/heads/${defaultBranch}..${tip}`]));

    if (unmerged !== 0 && !intent.force) {
      return yield* Effect.fail(new Error(`branch ${branch} has ${unmerged} commit(s) not in ${defaultBranch}; preserved for the operator`));
    }

    yield* git(["branch", "-D", "--", branch]);
  }

  return { path, branch, worktreeAlreadyRemoved: !listed, branchAlreadyDeleted };
});

const recordFailure = (store: Store, cleanup: Operation, hooks: ReadonlyArray<Operation>, reason: string) =>
  store.change((change) => Effect.gen(function* () {
    yield* recordRecoveryResultIn(change, cleanup.id, { status: "failed", result: { reason, recovered: true } });

    for (const hook of hooks) {
      yield* recordRecoveryResultIn(change, hook.id, { status: "interrupted", result: { reason: "cleanup recovery failed", cleanupId: cleanup.id } });
    }
  }));

const recoverOne = (options: CleanupRecoveryOptions, cleanup: Operation, hooks: ReadonlyArray<Operation>):
  Effect.Effect<CleanupRecovery, StoreError> => Effect.gen(function* () {
  const failed = (reason: string) => Effect.as(recordFailure(options.store, cleanup, hooks, reason),
    { operationId: cleanup.id, ticket: cleanup.ticket, outcome: "failed", reason } satisfies CleanupRecovery);

  const target = options.target(cleanup.factoryId);

  if (target === undefined) {return yield* failed("factory clone unavailable");}

  const decoded = decodeIntent(cleanup.intent);

  if (Option.isNone(decoded) || decoded.value.clonePath !== target.clonePath) {return yield* failed("recorded intent does not match the factory clone");}

  const intent = decoded.value;
  const gone = yield* Effect.result(absent(intent.path));

  if (Result.isFailure(gone)) {return yield* failed(gone.failure.message);}

  if (!gone.success) {
    // Present: rerun from the start. The rerun closes the interrupted records when it claims.
    const rerun = yield* Effect.result(options.worktrees.rerun(cleanup, hooks));

    if (Result.isSuccess(rerun)) {return { operationId: cleanup.id, ticket: cleanup.ticket, outcome: "rerun" } satisfies CleanupRecovery;}

    const after = yield* getOperation(options.store, cleanup.id);

    // Refused before its claim: the interrupted records still await a verdict.
    if (after?.status === "interrupted" && after.result === null) {return yield* failed(rerun.failure.message);}

    return { operationId: cleanup.id, ticket: cleanup.ticket, outcome: "failed", reason: rerun.failure.message } satisfies CleanupRecovery;
  }

  const finished = yield* Effect.result(finishRemoval(options, intent, target.factory.config.repository.default_branch));

  if (Result.isFailure(finished)) {return yield* failed(finished.failure.message);}

  const done = finished.success;

  yield* options.store.change((change) => Effect.gen(function* () {
    if (cleanup.ticket !== null) {
      yield* change.query(`UPDATE ticket SET worktree_path = NULL, branch = NULL WHERE factory_id = ? AND number = ? AND worktree_path = ? AND branch = ?`,
        [cleanup.factoryId, cleanup.ticket, done.path, done.branch]);
      yield* closeOpenHoldIn(change, { factoryId: cleanup.factoryId, kind: "hook_failure", subject: String(cleanup.ticket) }, "resolved");
      yield* change.recordHistory({ factoryId: cleanup.factoryId, kind: "ticket.worktree_removed", subject: String(cleanup.ticket),
        detail: { path: done.path, branch: done.branch, force: intent.force, recovered: true }, records: [ticketRecord(cleanup.ticket)] });
    }

    yield* recordRecoveryResultIn(change, cleanup.id, { status: "complete", result: { ...done, recovered: true } });

    for (const hook of hooks) {
      yield* recordRecoveryResultIn(change, hook.id, { status: "interrupted", result: { reason: "worktree already removed", cleanupId: cleanup.id } });
    }
  }));

  return { operationId: cleanup.id, ticket: cleanup.ticket, outcome: "finished" } satisfies CleanupRecovery;
});

/**
 * Reconciles a factory's interrupted cleanups and before_remove runs, oldest first. A
 * before_remove run interrupted without an interrupted cleanup for its ticket cannot be rerun
 * alone (the hook only runs inside a cleanup), so it is closed as interrupted.
 */
export const reconcileInterruptedCleanups = (options: CleanupRecoveryOptions, factoryId: string):
  Effect.Effect<ReadonlyArray<CleanupRecovery>, StoreError> => Effect.gen(function* () {
  const awaiting = yield* listOperationsAwaitingRecovery(options.store, factoryId);
  const cleanups = awaiting.filter((operation) => operation.kind === "cleanup");
  const hooks = awaiting.filter(isBeforeRemove);
  const recoveries: Array<CleanupRecovery> = [];

  for (const cleanup of cleanups) {
    recoveries.push(yield* recoverOne(options, cleanup, hooks.filter((hook) => hook.ticket === cleanup.ticket && hook.id > cleanup.id)));
  }

  const orphans = (yield* listOperationsAwaitingRecovery(options.store, factoryId)).filter(isBeforeRemove);

  if (orphans.length > 0) {
    yield* options.store.change((change) => Effect.forEach(orphans, (hook) =>
      recordRecoveryResultIn(change, hook.id, { status: "interrupted", result: { reason: "no interrupted cleanup to rerun it" } })));
  }

  return recoveries;
});
