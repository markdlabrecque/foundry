/**
 * The operator's way out of a failed worktree creation (PRD §10.2, failed-worktree hold).
 *
 * - `retry` creates the worktree again without deleting anything: from the current default branch
 *   head when the failed attempt left no branch, or on the existing branch when it descends from the
 *   recorded start (re-adding its worktree if the directory is gone). Anything else is refused, and
 *   the hold's evidence shows why.
 * - `discard` removes the partial worktree and branch, then creates both again from the current
 *   default branch head. When the branch has unmerged commits or the worktree has files, it needs the
 *   confirmation of the exact inspected state. A branch checked out in another worktree, a worktree
 *   on another branch, a locked worktree or an unregistered directory at the path is never touched.
 *
 * Both claim a new `worktree_create` intent-first; the hold is resolved in the change that publishes
 * the worktree. A failure records the new operation failed and refreshes the hold.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { messageOf } from "@foundry/protocol/errors";
import type { FailedWorktreeInspection, WorktreeRecreateResult } from "@foundry/protocol/worktrees-api";
import { Effect, Schema } from "effect";
import type { QueuedTicket } from "./assignments.js";
import { runCloneGit } from "./factory-clone.js";
import { beginOperationIn, getOperation, recordOperationResult } from "./operations.js";
import type { Operation, OperationDetail } from "./operations.js";
import type { StoreError } from "./store.js";
import { TicketError } from "./tickets.js";
import { GitFailed, inspectPartial } from "./worktree-recovery.js";
import type { PartialState } from "./worktree-recovery.js";
import { createTicketWorktree, publishTicketWorktreeIn, raiseFailedWorktreeIn, runFirstSetup } from "./worktrees.js";
import type { FailedCreation, TicketWorktreesOptions, WorktreeTarget } from "./worktrees.js";

const refuse = (message: string) => new TicketError({ code: "invalid_state", message });

const decodeIntent = Schema.decodeUnknownEffect(Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  defaultBranch: Schema.String,
  startCommit: Schema.optional(Schema.String),
}));

/** A ticket whose latest creation failed with its hold open, and that creation's recorded intent. */
interface FailedTicket {
  readonly ticket: QueuedTicket;
  readonly target: WorktreeTarget;
  readonly operation: Operation;
  readonly path: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly startCommit: string | undefined;
}

/** A Git failure becomes the operator's refusal; other errors pass through. */
const gitRefused = <A>(effect: Effect.Effect<A, GitFailed | StoreError | TicketError>): Effect.Effect<A, StoreError | TicketError> =>
  effect.pipe(Effect.catchTag("GitFailed", ({ reason }) => Effect.fail(refuse(reason))));

const evidenceOf = (failed: FailedTicket, operationId: number, reason: string, head: string | null = null) => ({
  factoryId: failed.ticket.factory_id, ticket: failed.ticket.number, operationId,
  path: failed.path, branch: failed.branch, defaultBranch: failed.defaultBranch,
  startCommit: failed.startCommit ?? null, head, reason,
} satisfies FailedCreation & { factoryId: string; ticket: number; operationId: number });

const result = (failed: FailedTicket, operation: Operation, startCommit: string): WorktreeRecreateResult => ({
  factoryId: failed.ticket.factory_id, ticket: failed.ticket.number, operationId: operation.id,
  path: failed.path, branch: failed.branch, startCommit,
});

/** Why discard must leave this Git alone, if it must. */
const discardBlocker = (failed: FailedTicket, state: PartialState): string | undefined => {
  const listed = state.worktree;

  if (failed.branch === failed.defaultBranch) {return "the ticket's branch is the default branch; never removed";}

  if (state.checkedOutElsewhere) {return "branch is checked out in another worktree; never removed";}

  if (listed !== undefined && listed.branch !== null && listed.branch !== failed.branch) {return "the worktree at the path is on another branch; preserved";}

  if (listed !== undefined && listed.locked !== undefined && listed.locked !== "initializing") {return "the worktree at the path is locked; preserved";}

  if (listed === undefined && existsSync(failed.path)) {return "an unregistered directory is at the worktree path; preserved, remove it yourself";}

  return undefined;
};

const isReasoned = Schema.is(Schema.Struct({ reason: Schema.String }));

export interface FailedWorktreeOptions extends TicketWorktreesOptions {
  readonly factories: () => ReadonlyArray<string>;
}

export const createFailedWorktreeActions = (options: FailedWorktreeOptions) => {
  const { store } = options;
  const env = options.env ?? process.env;

  const git = (cwd: string) => (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(args, env, cwd), catch: (cause) => new GitFailed({ reason: messageOf(cause) }),
  });

  const select = (factory: string | undefined, number: number) => Effect.gen(function* () {
    const names = options.factories();
    const selected = factory ?? (names.length === 1 ? names[0] : undefined);

    if (selected === undefined) {return yield* new TicketError({ code: "factory_required", message: "select a factory with --factory" });}

    if (!names.includes(selected)) {return yield* new TicketError({ code: "unknown_factory", message: `unknown factory ${selected}` });}

    if (!Number.isSafeInteger(number) || number < 1) {return yield* new TicketError({ code: "invalid_request", message: "ticket must be a positive integer" });}

    const [ticket] = yield* store.read<QueuedTicket>(`SELECT * FROM ticket WHERE factory_id = ? AND number = ?`, [selected, number]);

    if (ticket === undefined) {return yield* new TicketError({ code: "ticket_not_found", message: `no ticket ${number} in ${selected}` });}

    const hold = yield* store.read(`SELECT 1 FROM operator_hold WHERE factory_id = ? AND kind = 'failed_worktree'
      AND subject = ? AND state = 'open'`, [selected, String(number)]);

    const [latest] = yield* store.read<{ id: number }>(`SELECT id FROM operation WHERE factory_id = ? AND ticket_number = ?
      AND kind = 'worktree_create' ORDER BY id DESC LIMIT 1`, [selected, number]);

    const operation = latest === undefined ? undefined : yield* getOperation(store, latest.id);
    const creatable = ticket.state === "backlog" || (ticket.state === "stage" && ticket.status === "queued");

    if (hold.length === 0 || operation?.status !== "failed" || ticket.worktree_path !== null || !creatable) {
      return yield* refuse("ticket has no failed worktree creation awaiting the operator");
    }

    const target = options.target(selected);

    if (target === undefined) {return yield* refuse("factory clone unavailable");}

    const intent = yield* decodeIntent(operation.intent).pipe(Effect.mapError(() => refuse("the failed creation's intent is unreadable")));

    const failed: FailedTicket = { ticket, target, operation, path: intent.path, branch: intent.branch,
      defaultBranch: intent.defaultBranch, startCommit: intent.startCommit };

    return failed;
  });

  /** Refuses, refreshing the open hold so it shows why the command could not act. */
  const blocked = (failed: FailedTicket, state: PartialState, reason: string) =>
    Effect.flatMap(store.change((change) => raiseFailedWorktreeIn(change, evidenceOf(failed, failed.operation.id, reason, state.head ?? ""))),
      () => Effect.fail(refuse(reason)));

  /** Begins the replacing creation, provided the failed one is still the latest and its hold open. */
  const claim = (failed: FailedTicket, extra: OperationDetail) => store.change((change) => Effect.gen(function* () {
    const { factory_id: factoryId, number } = failed.ticket;

    const eligible = yield* change.query(`SELECT 1 FROM ticket t WHERE factory_id = ? AND number = ? AND worktree_path IS NULL
      AND (state = 'backlog' OR (state = 'stage' AND status = 'queued'))
      AND (SELECT id FROM operation o WHERE o.factory_id = t.factory_id AND o.ticket_number = t.number
        AND o.kind = 'worktree_create' ORDER BY id DESC LIMIT 1) = ?
      AND EXISTS (SELECT 1 FROM operator_hold h WHERE h.factory_id = t.factory_id AND h.kind = 'failed_worktree'
        AND h.subject = CAST(t.number AS TEXT) AND h.state = 'open')`, [factoryId, number, failed.operation.id]);

    if (eligible.length === 0) {return yield* refuse("the failed creation changed; inspect again");}

    return yield* beginOperationIn(change, { factoryId, kind: "worktree_create", ticket: number, intent: {
      clonePath: failed.target.clonePath, path: failed.path, branch: failed.branch, defaultBranch: failed.defaultBranch, ...extra,
    } });
  }));

  /** Records the replacing creation failed with a refreshed hold, then refuses with its reason. */
  const failCreation = (failed: FailedTicket, operation: Operation, reason: string) =>
    Effect.flatMap(store.change((change) => Effect.gen(function* () {
      yield* recordOperationResult(change, operation.id, { status: "failed", result: { reason } });
      yield* raiseFailedWorktreeIn(change, evidenceOf(failed, operation.id, reason));
    })), () => Effect.fail(refuse(reason)));

  /** Creates from the current default-branch head, publishes, then runs the first after_create. */
  const createFresh = (failed: FailedTicket, operation: Operation) => Effect.gen(function* () {
    const { factory, clonePath } = failed.target;

    const created = yield* createTicketWorktree({ store, factory, clonePath, ticket: failed.ticket, operation,
      path: failed.path, branch: failed.branch, defaultBranch: failed.defaultBranch, env });

    if (!created.created) {return yield* refuse(created.reason);}

    yield* runFirstSetup(store, factory, failed.ticket, created.setup, env);

    return result(failed, operation, created.startCommit);
  });

  const retry = (factory: string | undefined, number: number) => Effect.gen(function* () {
    const failed = yield* select(factory, number);
    const { path, branch, startCommit } = failed;
    const run = git(failed.target.clonePath);
    const state = yield* gitRefused(inspectPartial(run, path, branch));
    const listed = state.worktree;

    if (state.checkedOutElsewhere) {return yield* blocked(failed, state, "branch is checked out in another worktree; free it, then retry");}

    if (state.head === undefined) {
      if (listed !== undefined || existsSync(path)) {
        return yield* blocked(failed, state, "something is at the worktree path without the ticket's branch; discard it to create again");
      }

      return yield* createFresh(failed, yield* claim(failed, { retryOf: failed.operation.id }));
    }

    const head = state.head;

    const descends = startCommit !== undefined && (yield* run(["merge-base", "--is-ancestor", startCommit, head]).pipe(
      Effect.as(true), Effect.catchTag("GitFailed", () => Effect.succeed(false)),
    ));

    if (startCommit === undefined || !descends) {
      return yield* blocked(failed, state, "branch does not descend from the recorded start; discard it to create again from the default branch");
    }

    // A registration whose directory is gone is pruned and the worktree added again.
    const stale = listed !== undefined && !existsSync(path);
    const attach = listed === undefined || stale;

    if (listed === undefined ? existsSync(path) : listed.locked !== undefined || (!stale && listed.branch !== branch)) {
      return yield* blocked(failed, state, "the worktree path holds something other than the ticket's branch; discard it to create again");
    }

    // The existing branch is kept as the ticket's, with its recorded start (PRD §10.2: commits count as created).
    const operation = yield* claim(failed, { retryOf: failed.operation.id, startCommit, adopted: head });

    if (attach) {
      yield* Effect.gen(function* () {
        yield* run(["worktree", "prune"]);
        yield* run(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--", path, branch]);
      }).pipe(Effect.catchTag("GitFailed", ({ reason }) => failCreation(failed, operation, reason)));
    }

    const { factory: loaded } = failed.target;

    const setup = yield* store.change((change) => Effect.gen(function* () {
      yield* recordOperationResult(change, operation.id, { status: "complete", result: { path, branch, startCommit, head, adopted: true } });

      return yield* publishTicketWorktreeIn(change, failed.ticket, operation.id, { path, branch, startCommit },
        loaded.config.worktrees?.after_create);
    }));

    yield* runFirstSetup(store, loaded, failed.ticket, setup, env);

    return result(failed, operation, startCommit);
  });

  /** What discard would lose, bound to the exact state by its confirmation. */
  const survey = (failed: FailedTicket) => Effect.gen(function* () {
    const run = git(failed.target.clonePath);
    const state = yield* inspectPartial(run, failed.path, failed.branch);
    const blocker = discardBlocker(failed, state);

    if (blocker !== undefined) {return yield* blocked(failed, state, blocker);}

    const base = yield* run(["rev-parse", "--verify", `refs/heads/${failed.defaultBranch}^{commit}`]);
    const commits = state.head === undefined ? "" : yield* run(["log", "--format=%H %s", `${base}..${state.head}`, "--"]);
    const present = state.worktree !== undefined && existsSync(failed.path);
    const inWorktree = git(failed.path);

    // A half-created worktree may have no readable HEAD; that unreadability is itself shown as a loss.
    const files = !present ? "" : yield* inWorktree(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]).pipe(
      Effect.catchTag("GitFailed", ({ reason }) => Effect.succeed(`(worktree status unreadable: ${reason})`)),
    );

    const diff = !present ? "" : yield* inWorktree(["diff", "--binary", "HEAD", "--"]).pipe(Effect.catchTag("GitFailed", () => Effect.succeed("")));
    const head = state.head ?? "";
    const confirmation = createHash("sha256").update(JSON.stringify({ path: failed.path, branch: failed.branch, head, base, commits, files, diff })).digest("hex");

    return { state, head, commits, files, confirmation, needsConfirmation: commits !== "" || files !== "" };
  });

  const inspectFailed = (factory: string | undefined, number: number) => Effect.gen(function* () {
    const failed = yield* select(factory, number);
    const surveyed = yield* gitRefused(survey(failed));
    const recorded = failed.operation.result;

    const inspection: FailedWorktreeInspection = {
      factoryId: failed.ticket.factory_id, ticket: failed.ticket.number, operationId: failed.operation.id,
      path: failed.path, branch: failed.branch, reason: isReasoned(recorded) ? recorded.reason : "",
      head: surveyed.head, commits: surveyed.commits, files: surveyed.files,
      needsConfirmation: surveyed.needsConfirmation, confirmation: surveyed.confirmation,
    };

    return inspection;
  });

  const discard = (factory: string | undefined, number: number, confirmation?: string) => Effect.gen(function* () {
    const failed = yield* select(factory, number);
    const { path, branch } = failed;
    const surveyed = yield* gitRefused(survey(failed));
    const { state } = surveyed;

    if (surveyed.needsConfirmation && confirmation !== surveyed.confirmation) {
      return yield* refuse("the branch has unmerged commits or the worktree has files; inspect and confirm to discard them");
    }

    const operation = yield* claim(failed, { discardOf: failed.operation.id, discardedHead: surveyed.head });
    const run = git(failed.target.clonePath);

    yield* Effect.gen(function* () {
      const listed = state.worktree;

      if (listed !== undefined) {
        // Only an `initializing` lock reaches here: a crash inside `git worktree add` left it.
        if (listed.locked !== undefined) {yield* run(["worktree", "unlock", "--", path]);}

        if (existsSync(path)) {yield* run(["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", "--", path]);}
      }

      yield* run(["worktree", "prune"]);

      // Deleted only while it still points at the inspected head.
      if (state.head !== undefined) {yield* run(["update-ref", "-d", `refs/heads/${branch}`, state.head]);}
    }).pipe(Effect.catchTag("GitFailed", ({ reason }) => failCreation(failed, operation, reason)));

    return yield* createFresh(failed, operation);
  });

  return { inspectFailed, retry, discard };
};
