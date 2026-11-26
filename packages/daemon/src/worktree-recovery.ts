/**
 * Startup recovery of an interrupted `worktree_create` (PRD §10.2, step 3).
 *
 * - A branch with commits beyond its recorded starting point counts as created: it is published on
 *   the ticket exactly as a normal creation would be, and its first after_create runs.
 * - Otherwise the partial worktree and branch are removed and created again, as a new
 *   `worktree_create` operation. The interrupted one keeps status `interrupted`, with a recovery
 *   result naming the new one, recorded in the change that begins it.
 * - Git that this recovery cannot prove is Foundry's own partial work (a branch Foundry did not
 *   start, a worktree on another branch, a branch checked out elsewhere) is left alone and the
 *   operation is recorded failed, so nothing that may hold authored work is ever deleted. A
 *   failed-worktree hold is raised with it; `foundry worktree retry` or `discard` resolves it
 *   (worktree-retry.ts).
 *
 * Recovery runs in two phases per factory. Settling inspects Git, removes provably empty partial
 * work and records every verdict, so the factory's queue can resume as soon as it returns; the
 * rebuild and first after_create then finish in the background.
 *
 * Git never runs inside a store transaction. Cleanup is idempotent, so a crash during recovery
 * leaves the operation awaiting recovery (or the new creation running) and the next startup
 * repeats it.
 */
import { existsSync, realpathSync } from "node:fs";
import { messageOf } from "@foundry/protocol/errors";
import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { QueuedTicket } from "./assignments.js";
import { runCloneGit } from "./factory-clone.js";
import { beginOperationIn, listOperationsAwaitingRecovery, recordRecoveryResultIn } from "./operations.js";
import type { Operation, OperationDetail } from "./operations.js";
import type { Store } from "./store.js";
import { buildTicketWorktree, publishTicketWorktreeIn, raiseFailedWorktreeIn, runFirstSetup } from "./worktrees.js";
import type { FailedCreation, WorktreeTarget } from "./worktrees.js";

export interface WorktreeSettleOptions {
  readonly store: Store;
  readonly target: (factory: string) => WorktreeTarget | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /** One operation's recovery failed; the others carry on. Defaults to logging the cause. */
  readonly onFailure?: (operationId: number, cause: Cause.Cause<unknown>) => void;
}

export interface WorktreeRecoveryOptions extends WorktreeSettleOptions {
  /** The started factories; another factory's operations wait for a run that starts it. */
  readonly factories: ReadonlyArray<string>;
}

/** What recovery did with one interrupted creation. */
export type WorktreeVerdict = "kept" | "recreated" | "refused" | "skipped";

/** One interrupted creation's recorded verdict; `reason` explains a refused or skipped one. */
export interface WorktreeRecovered {
  readonly operation: Operation;
  readonly verdict: WorktreeVerdict;
  readonly reason?: string;
}

/** A recorded verdict and the work, if any, still to finish in the background. */
interface Settled {
  readonly recovered: WorktreeRecovered;
  readonly finish?: Effect.Effect<void, unknown>;
}

export class GitFailed extends Data.TaggedError("GitFailed")<{ readonly reason: string }> {}

const decodeIntent = Schema.decodeUnknownEffect(Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  defaultBranch: Schema.String,
  startCommit: Schema.optional(Schema.String),
}));

/** One record of `git worktree list --porcelain`. */
export interface ListedWorktree {
  path: string;
  /** The checked-out branch, `null` when detached or not yet set. */
  branch: string | null;
  /** The lock reason (`""` without one), `undefined` when unlocked. */
  locked: string | undefined;
}

export const parseWorktrees = (listing: string): ReadonlyArray<ListedWorktree> => {
  const worktrees: Array<ListedWorktree> = [];
  let current: ListedWorktree | undefined;

  // Records are NUL-separated fields, each record ended by an empty field.
  for (const field of listing.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), branch: null, locked: undefined };
      worktrees.push(current);
    } else if (current === undefined) {continue;}
    else if (field.startsWith("branch refs/heads/")) {current.branch = field.slice("branch refs/heads/".length);}
    else if (field === "locked") {current.locked = "";}
    else if (field.startsWith("locked ")) {current.locked = field.slice("locked ".length);}
  }

  return worktrees;
};

export interface PartialState {
  /** The branch's commit, or `undefined` when the branch does not exist. */
  readonly head: string | undefined;
  /** The worktree registered at the path, if any. */
  readonly worktree: ListedWorktree | undefined;
  /** Whether a worktree at another path has the branch checked out. */
  readonly checkedOutElsewhere: boolean;
}

/** Reads the branch and the worktrees registered in the clone. */
export const inspectPartial = (git: (args: ReadonlyArray<string>) => Effect.Effect<string, GitFailed>, path: string, branch: string) =>
  Effect.gen(function* () {
    const head = yield* git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).pipe(
      Effect.catchTag("GitFailed", () => Effect.succeed("")),
    );

    const worktrees = parseWorktrees(yield* git(["worktree", "list", "--porcelain", "-z"]));
    // Git may list the resolved path, so a symlinked root still matches.
    const paths = new Set([path, ...(existsSync(path) ? [realpathSync(path)] : [])]);

    const state: PartialState = {
      head: head === "" ? undefined : head,
      worktree: worktrees.find((listed) => paths.has(listed.path)),
      checkedOutElsewhere: worktrees.some((listed) => !paths.has(listed.path) && listed.branch === branch),
    };

    return state;
  });

export type PartialCreation =
  | { readonly verdict: "kept"; readonly head: string }
  | { readonly verdict: "cleared" }
  | { readonly verdict: "refused"; readonly reason: string; readonly head: string };

/**
 * Applies the recovery rules to whatever an earlier creation from `startCommit` left in Git:
 * `kept` when the branch has authored commits in its worktree; `cleared` once a provably empty
 * partial worktree and branch are removed, so the creation can run again; `refused` when Git holds
 * something this cannot prove is Foundry's own partial work. Nothing with commits, nothing on
 * another branch and no branch checked out elsewhere is ever removed.
 */
export const reconcilePartialCreation = (
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, GitFailed>, path: string, branch: string, startCommit: string,
) => Effect.gen(function* () {
  const state = yield* inspectPartial(git, path, branch);
  const listed = state.worktree;

  const ahead = state.head === undefined ? 0
    : Number(yield* git(["rev-list", "--count", `${startCommit}..${state.head}`]));

  if (ahead > 0 && listed?.branch === branch && existsSync(path)) {
    const kept: PartialCreation = { verdict: "kept", head: state.head ?? "" };

    return kept;
  }

  // A crash inside `git worktree add` leaves it locked as `initializing`, possibly before HEAD names the branch.
  const initializing = listed?.locked === "initializing";
  const onBranch = listed === undefined || listed.branch === branch || (initializing && listed.branch === null);

  // Only a branch still at the recorded start, in a worktree on that branch, is provably empty.
  const refusal = ahead > 0 ? "branch has commits but its worktree is missing; preserved for the operator"
    : !onBranch || (state.head !== undefined && state.head !== startCommit)
      ? "partial worktree or branch does not match the recorded creation; preserved for the operator"
      : state.checkedOutElsewhere ? "branch is checked out in another worktree; preserved for the operator" : undefined;

  if (refusal !== undefined) {
    const refused: PartialCreation = { verdict: "refused", reason: refusal, head: state.head ?? "" };

    return refused;
  }

  if (listed !== undefined) {
    yield* git(["worktree", "remove", ...(initializing ? ["-f", "-f"] : ["--force"]), "--", path]);
  }

  yield* git(["worktree", "prune"]);

  // Deleted only while it still points at the recorded start.
  if (state.head !== undefined) {yield* git(["update-ref", "-d", `refs/heads/${branch}`, startCommit]);}

  const cleared: PartialCreation = { verdict: "cleared" };

  return cleared;
});

/**
 * Settles one interrupted creation: records its verdict and returns what remains to run.
 * `undefined` start commit: the operation was interrupted before it recorded its base, so it
 * changed no Git state and is simply created again.
 */
const settleOne = (options: WorktreeSettleOptions, target: WorktreeTarget, interrupted: Operation) => Effect.gen(function* () {
  const { store } = options;
  const env = options.env ?? process.env;
  const { clonePath, factory } = target;

  const settle = (status: "complete" | "failed" | "interrupted", result: OperationDetail) =>
    store.change((change) => recordRecoveryResultIn(change, interrupted.id, { status, result }));

  // A refused creation needs the operator: the failure and its hold commit together (PRD §10.2).
  const settleFailed = (failed: FailedCreation) => store.change((change) => Effect.gen(function* () {
    yield* recordRecoveryResultIn(change, interrupted.id, { status: "failed", result: { recreated: false, ...failed } });

    if (interrupted.ticket !== null) {
      yield* raiseFailedWorktreeIn(change, { factoryId: interrupted.factoryId, ticket: interrupted.ticket, operationId: interrupted.id, ...failed });
    }
  }));

  const verdict = (value: WorktreeVerdict, reason?: string): Settled =>
    ({ recovered: reason === undefined ? { operation: interrupted, verdict: value } : { operation: interrupted, verdict: value, reason } });

  const decoded = yield* Effect.exit(decodeIntent(interrupted.intent));

  if (Exit.isFailure(decoded)) {
    yield* settle("interrupted", { recreated: false, reason: "invalid intent" });

    return verdict("skipped", "invalid intent");
  }

  const intent = decoded.value;
  const { path, branch } = intent;

  const [ticket] = yield* store.read<QueuedTicket>(`SELECT * FROM ticket WHERE factory_id = ? AND number = ?`,
    [interrupted.factoryId, interrupted.ticket]);

  // An ended or missing ticket needs no worktree; its Git, if any, is left for the operator.
  if (ticket === undefined || ticket.state === "completed" || ticket.state === "cancelled" || ticket.worktree_path !== null) {
    const reason = ticket === undefined ? "ticket missing"
      : ticket.worktree_path === null ? `ticket ${ticket.state}` : "ticket already has a worktree";

    yield* settle("interrupted", { recreated: false, reason });

    return verdict("skipped", reason);
  }

  const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(args, env, clonePath), catch: (cause) => new GitFailed({ reason: messageOf(cause) }),
  });

  return yield* Effect.gen(function* () {
    if (intent.startCommit !== undefined) {
      const startCommit = intent.startCommit;
      const partial = yield* reconcilePartialCreation(git, path, branch, startCommit);

      if (partial.verdict === "kept") {
        // Authored commits: the creation counts as done and nothing is removed.
        const setup = yield* store.change((change) => Effect.gen(function* () {
          yield* recordRecoveryResultIn(change, interrupted.id, {
            status: "complete", result: { path, branch, startCommit, head: partial.head, recovered: "kept" },
          });

          return yield* publishTicketWorktreeIn(change, ticket, interrupted.id, { path, branch, startCommit },
            factory.config.worktrees?.after_create, "cleared");
        }));

        const kept: Settled = { ...verdict("kept"), finish: runFirstSetup(store, factory, ticket, setup, env) };

        return kept;
      }

      if (partial.verdict === "refused") {
        yield* settleFailed({ path, branch, defaultBranch: intent.defaultBranch, startCommit, head: partial.head, reason: partial.reason });

        return verdict("refused", partial.reason);
      }
    }

    const operation = yield* store.change((change) => Effect.gen(function* () {
      const next = yield* beginOperationIn(change, { factoryId: interrupted.factoryId, kind: "worktree_create", ticket: ticket.number,
        intent: { clonePath, path, branch, defaultBranch: intent.defaultBranch, recreateOf: interrupted.id } });

      yield* recordRecoveryResultIn(change, interrupted.id, { status: "interrupted", result: { recreated: true, recreateOperationId: next.id } });

      return next;
    }));

    const recreated: Settled = {
      ...verdict("recreated"),
      finish: Effect.asVoid(buildTicketWorktree({ store, factory, clonePath, ticket, operation, path, branch, defaultBranch: intent.defaultBranch, env })),
    };

    return recreated;
  }).pipe(Effect.catchTag("GitFailed", ({ reason }) => Effect.as(
    settleFailed({ path, branch, defaultBranch: intent.defaultBranch, startCommit: intent.startCommit ?? null, head: null, reason }),
    verdict("refused", reason),
  )));
});

/** Passes a success through; reports a failure (but not a plain interruption) and turns it into `undefined`. */
const report = (onFailure: WorktreeSettleOptions["onFailure"], operationId: number) =>
  <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A | undefined> => {
    if (Exit.isSuccess(exit)) {return Effect.succeed(exit.value);}

    // An interrupted recovery stops quietly; the next startup picks it up again.
    if (Cause.hasInterruptsOnly(exit.cause)) {return Effect.succeed(undefined);}

    if (onFailure === undefined) {
      return Effect.as(Effect.logError(`worktree recovery of operation ${operationId} failed`, exit.cause), undefined);
    }

    onFailure(operationId, exit.cause);

    return Effect.succeed(undefined);
  };

/**
 * Records a verdict for every interrupted `worktree_create` of one factory, oldest first, and
 * returns them with the work still to finish. Once this returns, none of them closes the queue.
 * Each operation is isolated: one failing is reported through `onFailure` and the others carry on.
 */
const settleFactory = (options: WorktreeSettleOptions, factoryId: string) => Effect.gen(function* () {
  const target = options.target(factoryId);

  if (target === undefined) {return [];}

  const settled: Array<Settled> = [];

  for (const interrupted of (yield* listOperationsAwaitingRecovery(options.store, factoryId)).filter((operation) => operation.kind === "worktree_create")) {
    const one = yield* Effect.exit(settleOne(options, target, interrupted)).pipe(Effect.flatMap(report(options.onFailure, interrupted.id)));

    if (one !== undefined) {settled.push(one);}
  }

  return settled;
});

const finishing = (options: WorktreeSettleOptions, settled: Settled) => settled.finish === undefined ? Effect.void
  : Effect.asVoid(Effect.exit(settled.finish).pipe(Effect.flatMap(report(options.onFailure, settled.recovered.operation.id))));

/** Reconciles every interrupted `worktree_create` of the given factories to the end, including rebuilds and setup. */
export const recoverInterruptedWorktrees = (options: WorktreeRecoveryOptions) => Effect.gen(function* () {
  const recovered: Array<WorktreeRecovered> = [];

  for (const factoryId of options.factories) {
    for (const settled of yield* settleFactory(options, factoryId)) {
      yield* finishing(options, settled);
      recovered.push(settled.recovered);
    }
  }

  return recovered;
});

/**
 * Daemon recovery: `settle` records one factory's verdicts and resolves once its queue may resume,
 * leaving rebuilds and first after_create runs in the background. `idle` waits for them; `stop` cancels everything.
 */
export const createWorktreeRecovery = (options: WorktreeSettleOptions & { readonly onError: (error: Error) => void }) => {
  const controller = new AbortController();
  const running = new Set<Promise<unknown>>();

  const settleOptions: WorktreeSettleOptions = {
    ...options,
    onFailure: options.onFailure ?? ((operationId, cause) => {
      options.onError(new Error(`operation ${operationId}: ${Cause.pretty(cause)}`));
    }),
  };

  const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A | undefined> => {
    const done = Effect.runPromiseExit(effect, { signal: controller.signal }).then((exit) => {
      if (Exit.isSuccess(exit)) {return exit.value;}

      if (!controller.signal.aborted && !Cause.hasInterruptsOnly(exit.cause)) {options.onError(new Error(Cause.pretty(exit.cause)));}

      return undefined;
    });

    running.add(done);
    void done.then(() => running.delete(done));

    return done;
  };

  return {
    settle: async (factoryId: string): Promise<ReadonlyArray<WorktreeRecovered>> => {
      if (controller.signal.aborted) {return [];}

      const settled = (await run(settleFactory(settleOptions, factoryId))) ?? [];

      for (const one of settled) {void run(finishing(settleOptions, one));}

      return settled.map((one) => one.recovered);
    },
    /** Resolves once every background rebuild and setup started so far has finished. */
    idle: async (): Promise<void> => {
      while (running.size > 0) {await Promise.all(running);}
    },
    stop: async (): Promise<void> => {
      controller.abort();
      await Promise.all(running);
    },
  };
};
