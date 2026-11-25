/**
 * Startup recovery of an interrupted `worktree_create` (PRD §10.2, step 3).
 *
 * - A branch with commits beyond its recorded starting point counts as created: it is published on
 *   the ticket exactly as a normal creation would be, and its first after_create runs.
 * - Otherwise the partial worktree and branch are removed and created again, as a new
 *   `worktree_create` operation. The interrupted one keeps status `interrupted`, with a recovery
 *   result naming the new one, recorded in the change that begins it.
 * - Git that this recovery cannot prove is Foundry's own partial work (a branch Foundry did not
 *   start, a worktree on another branch) is left alone and the operation is recorded failed, so
 *   nothing that may hold authored work is ever deleted. The ticket then needs the operator.
 *
 * Git never runs inside a store transaction. Cleanup is idempotent, so a crash during recovery
 * leaves the operation awaiting recovery and the next startup repeats it.
 */
import { existsSync, realpathSync } from "node:fs";
import { messageOf } from "@foundry/protocol/errors";
import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { QueuedTicket } from "./assignments.js";
import { runCloneGit } from "./factory-clone.js";
import { beginOperationIn, listOperationsAwaitingRecovery, recordRecoveryResultIn } from "./operations.js";
import type { Operation, OperationDetail } from "./operations.js";
import type { Store } from "./store.js";
import { buildTicketWorktree, publishTicketWorktreeIn, runFirstSetup } from "./worktrees.js";
import type { WorktreeTarget } from "./worktrees.js";

export interface WorktreeRecoveryOptions {
  readonly store: Store;
  /** The started factories' targets; another factory's operations wait for a run that starts it. */
  readonly factories: ReadonlyArray<string>;
  readonly target: (factory: string) => WorktreeTarget | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/** What recovery did with one interrupted creation. */
export type WorktreeVerdict = "kept" | "recreated" | "refused" | "skipped";

/** Keeps a verdict literal typed as a verdict through generator return inference. */
const verdictOf = (verdict: WorktreeVerdict): WorktreeVerdict => verdict;

class GitFailed extends Data.TaggedError("GitFailed")<{ readonly reason: string }> {}

const decodeIntent = Schema.decodeUnknownSync(Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  defaultBranch: Schema.String,
  startCommit: Schema.optional(Schema.String),
}));

interface PartialState {
  /** The branch's commit, or `undefined` when the branch does not exist. */
  readonly head: string | undefined;
  /** The branch checked out by the worktree registered at the path, `null` if detached, `undefined` if none. */
  readonly worktreeBranch: string | null | undefined;
}

/** Reads the branch and the worktree registered at `path`, from the clone. */
const inspect = (git: (args: ReadonlyArray<string>) => Effect.Effect<string, GitFailed>, path: string, branch: string) =>
  Effect.gen(function* () {
    const head = yield* git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).pipe(
      Effect.catchTag("GitFailed", () => Effect.succeed("")),
    );

    const listing = yield* git(["worktree", "list", "--porcelain", "-z"]);
    // Git may list the resolved path, so a symlinked root still matches.
    const paths = new Set([path, ...(existsSync(path) ? [realpathSync(path)] : [])]);
    let worktreeBranch: string | null | undefined;

    // Records are NUL-separated fields, each record ended by an empty field.
    let current: string | undefined;

    for (const field of listing.split("\0")) {
      if (field.startsWith("worktree ")) {current = field.slice("worktree ".length);}
      else if (paths.has(current ?? "") && field.startsWith("branch ")) {worktreeBranch = field.slice("branch refs/heads/".length);}
      else if (paths.has(current ?? "") && field === "detached") {worktreeBranch = null;}
      else if (paths.has(current ?? "") && worktreeBranch === undefined && field === "") {worktreeBranch = null;}
    }

    const state: PartialState = { head: head === "" ? undefined : head, worktreeBranch };

    return state;
  });

/**
 * Reconciles one interrupted creation. `undefined` start commit: the operation was interrupted
 * before it recorded its base, so it changed no Git state and is simply created again.
 */
const recoverOne = (options: WorktreeRecoveryOptions, target: WorktreeTarget, interrupted: Operation) => Effect.gen(function* () {
  const { store } = options;
  const env = options.env ?? process.env;
  const { clonePath, factory } = target;
  const intent = decodeIntent(interrupted.intent);
  const { path, branch } = intent;

  const [ticket] = yield* store.read<QueuedTicket>(`SELECT * FROM ticket WHERE factory_id = ? AND number = ?`,
    [interrupted.factoryId, interrupted.ticket]);

  const settle = (status: "complete" | "failed" | "interrupted", result: OperationDetail) =>
    store.change((change) => recordRecoveryResultIn(change, interrupted.id, { status, result }));

  // An ended or missing ticket needs no worktree; its Git, if any, is left for the operator.
  if (ticket === undefined || ticket.state === "completed" || ticket.state === "cancelled" || ticket.worktree_path !== null) {
    yield* settle("interrupted", { recreated: false, reason: ticket === undefined ? "ticket missing"
      : ticket.worktree_path === null ? `ticket ${ticket.state}` : "ticket already has a worktree" });

    return verdictOf("skipped");
  }

  const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(args, env, clonePath), catch: (cause) => new GitFailed({ reason: messageOf(cause) }),
  });

  return yield* Effect.gen(function* () {
    if (intent.startCommit !== undefined) {
      const startCommit = intent.startCommit;
      const state = yield* inspect(git, path, branch);
      const onBranch = state.worktreeBranch === undefined || state.worktreeBranch === branch;

      const ahead = state.head === undefined ? 0
        : Number(yield* git(["rev-list", "--count", `${startCommit}..${state.head}`]));

      if (ahead > 0 && state.worktreeBranch === branch && existsSync(path)) {
        // Authored commits: the creation counts as done and nothing is removed.
        const setup = yield* store.change((change) => Effect.gen(function* () {
          yield* recordRecoveryResultIn(change, interrupted.id, {
            status: "complete", result: { path, branch, startCommit, head: state.head ?? "", recovered: "kept" },
          });

          return yield* publishTicketWorktreeIn(change, ticket, interrupted.id, { path, branch, startCommit },
            factory.config.worktrees?.after_create);
        }));

        yield* runFirstSetup(store, factory, ticket, setup, env);

        return verdictOf("kept");
      }

      // Only a branch still at the recorded start, in a worktree on that branch, is provably empty.
      if (ahead > 0 || !onBranch || (state.head !== undefined && state.head !== startCommit)) {
        yield* settle("failed", { recreated: false, path, branch, startCommit, head: state.head ?? "",
          reason: ahead > 0 ? "branch has commits but its worktree is missing; preserved for the operator"
            : "partial worktree or branch does not match the recorded creation; preserved for the operator" });

        return verdictOf("refused");
      }

      if (state.worktreeBranch !== undefined) {yield* git(["worktree", "remove", "--force", "--", path]);}

      yield* git(["worktree", "prune"]);

      // Deleted only while it still points at the recorded start.
      if (state.head !== undefined) {yield* git(["update-ref", "-d", `refs/heads/${branch}`, startCommit]);}
    }

    const operation = yield* store.change((change) => Effect.gen(function* () {
      const next = yield* beginOperationIn(change, { factoryId: interrupted.factoryId, kind: "worktree_create", ticket: ticket.number,
        intent: { clonePath, path, branch, defaultBranch: intent.defaultBranch, recreateOf: interrupted.id } });

      yield* recordRecoveryResultIn(change, interrupted.id, { status: "interrupted", result: { recreated: true, recreateOperationId: next.id } });

      return next;
    }));

    yield* buildTicketWorktree({ store, factory, clonePath, ticket, operation, path, branch, defaultBranch: intent.defaultBranch, env });

    return verdictOf("recreated");
  }).pipe(Effect.catchTag("GitFailed", ({ reason }) => Effect.as(
    settle("failed", { recreated: false, path, branch, reason }), verdictOf("refused"),
  )));
});

/** Reconciles every interrupted `worktree_create` of the given factories, oldest first. */
export const recoverInterruptedWorktrees = (options: WorktreeRecoveryOptions) => Effect.gen(function* () {
  const verdicts: Array<{ readonly operation: Operation; readonly verdict: WorktreeVerdict }> = [];

  for (const factoryId of options.factories) {
    const target = options.target(factoryId);

    if (target === undefined) {continue;}

    const interrupted = (yield* listOperationsAwaitingRecovery(options.store, factoryId))
      .filter((operation) => operation.kind === "worktree_create");

    for (const operation of interrupted) {
      verdicts.push({ operation, verdict: yield* recoverOne(options, target, operation) });
    }
  }

  return verdicts;
});

/** Runs recovery in the background, so Git or a first after_create never holds up startup. */
export const startWorktreeRecovery = (options: WorktreeRecoveryOptions & {
  readonly onRecovered?: (operation: Operation, verdict: WorktreeVerdict) => void;
  readonly onError: (error: Error) => void;
}): (() => Promise<void>) => {
  const controller = new AbortController();

  const done = Effect.runPromiseExit(recoverInterruptedWorktrees(options), { signal: controller.signal }).then((exit) => {
    if (Exit.isSuccess(exit)) {
      for (const { operation, verdict } of exit.value) {options.onRecovered?.(operation, verdict);}
    } else if (!controller.signal.aborted) {
      options.onError(new Error(Cause.pretty(exit.cause)));
    }
  });

  return async () => {
    controller.abort();
    await done;
  };
};
