/**
 * Recovery of interrupted integrations (PRD §10.2 step 3, "Interrupted operations: Integration").
 * Runs after startup marked running operations interrupted, once the factory's clone is known, and
 * before the factory's queue is resumed. It compares the integration's recorded intent (the
 * approved commit and the default branch head it started from) with the clone's default branch:
 *
 * - The head is the approved commit, or a merge of the recorded head and the approved commit: it
 *   landed. The integration completes and the ticket completes, as if the run had finished.
 * - The head is still the recorded head, or no head was recorded yet: nothing landed. The temporary
 *   worktree is discarded and the integration is queued again from the start, so hooks and
 *   verification may run twice.
 * - Anything else is indeterminate: the ticket pauses with its approvals kept, an
 *   indeterminate-integration hold is raised, and the factory's queue stays closed until the
 *   operator declares it landed or not. The default branch is never reset.
 */
import { existsSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Clock, Data, Effect, Exit, Option, Schema } from "effect";
import type { Cause } from "effect";
import { expectDefined, messageOf } from "@foundry/protocol/errors";
import { ticketApprovalLock } from "./approval-coordination.js";
import { runCloneGit } from "./factory-clone.js";
import type { SyncTarget } from "./factory-sync.js";
import { ticketRecord } from "./history-records.js";
import { raiseHoldIn } from "./holds.js";
import { listOperationsAwaitingRecovery, recordRecoveryResultIn, requeueInterruptedOperationIn } from "./operations.js";
import type { Operation, OperationDetail } from "./operations.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Change, Store, StoreError } from "./store.js";
import type { WorktreeService } from "./worktree-cleanup.js";

/** What recovery decided for one interrupted integration. */
export type IntegrationVerdict = "landed" | "rerun" | "indeterminate";

export interface IntegrationRecovery {
  /** The operation after recovery's verdict committed. */
  readonly operation: Operation;
  readonly verdict: IntegrationVerdict;
}

export interface IntegrationRecoveryOptions {
  readonly store: Store;
  /** The clone of each started factory; `undefined` leaves its integrations awaiting recovery. */
  readonly target: (factory: string) => SyncTarget | undefined;
  /** Git's environment. Default: the process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Cleanup after a landed integration completes, as after an uninterrupted one. */
  readonly worktrees?: Pick<WorktreeService, "clean">;
  /** One integration's recovery failed or died; the factory's other integrations still recover. */
  readonly onFailure?: (operation: Operation, cause: Cause.Cause<StoreError>) => void;
}

/** What `integrateApprovedCommit` records in the intent as it goes. */
const RecordedIntent = Schema.Struct({
  approvalId: Schema.Number,
  approvedCommit: Schema.String,
  branchLock: Schema.optionalKey(Schema.String),
  previousHead: Schema.optionalKey(Schema.String),
  defaultBranch: Schema.optionalKey(Schema.String),
  scratchPath: Schema.optionalKey(Schema.String),
  verification: Schema.optionalKey(Schema.Struct({ path: Schema.optionalKey(Schema.String) })),
});

type RecordedIntent = typeof RecordedIntent.Type;

const decodeIntent = Schema.decodeUnknownOption(RecordedIntent);

const IntegrationHook = Schema.Struct({ integrationOperationId: Schema.Number });

const isIntegrationHook = Schema.is(IntegrationHook);

/** A Git step of recovery failed; never leaves this module. */
class RecoveryGitFailed extends Data.TaggedError("RecoveryGitFailed")<{ readonly reason: string }> {}

type Classification =
  | { readonly verdict: "landed"; readonly head: string }
  | { readonly verdict: "rerun"; readonly head: string | null }
  | { readonly verdict: "indeterminate"; readonly head: string | null; readonly reason: string };

/**
 * The ticket-branch lock the interrupted run provably took: recorded right after it was taken.
 * Older intents recorded only the head, which the run reads while already holding the lock.
 */
const branchLockOf = (
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, RecoveryGitFailed>,
  clonePath: string,
  intent: RecordedIntent | undefined,
  branch: string | null,
): Effect.Effect<string | null> => {
  if (intent?.branchLock !== undefined) {return Effect.succeed(intent.branchLock);}

  if (intent?.previousHead === undefined || branch === null) {return Effect.succeed(null);}

  return git(["rev-parse", "--git-path", `refs/heads/${branch}.lock`]).pipe(
    Effect.map((path) => resolve(clonePath, path)),
    Effect.orElseSucceed(() => null),
  );
};

/** The scratch checkout the interrupted run may have left, if it recorded one. */
const temporaryWorktreeOf = (intent: RecordedIntent | undefined): string | null =>
  intent?.scratchPath ?? intent?.verification?.path ?? null;

/**
 * Why the clone cannot take a rerun, if it cannot: Git died mid-write (its index lock is left) or
 * the checkout is dirty. A rerun would only refuse again on every restart, so the operator decides.
 */
const brokenClone = (
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, RecoveryGitFailed>,
  clonePath: string,
): Effect.Effect<string | undefined, RecoveryGitFailed> => Effect.gen(function* () {
  const indexLock = resolve(clonePath, yield* git(["rev-parse", "--git-path", "index.lock"]));

  if (existsSync(indexLock)) {return `factory clone has a leftover Git index lock: ${indexLock}`;}

  const status = yield* git(["status", "--porcelain", "--untracked-files=all"]);

  return status === "" ? undefined : `factory clone has uncommitted changes:\n${status}`;
});

const classify = (
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, RecoveryGitFailed>,
  clonePath: string,
  intent: RecordedIntent | undefined,
  defaultBranch: string,
): Effect.Effect<Classification> => Effect.gen(function* () {
  if (intent === undefined) {
    return { verdict: "indeterminate", head: null, reason: "recorded intent names no approved commit" } as const;
  }

  const rerun = (head: string | null) => Effect.map(brokenClone(git, clonePath), (broken): Classification =>
    (broken === undefined ? { verdict: "rerun", head } : { verdict: "indeterminate", head, reason: broken }));

  // The head is recorded before anything is prepared or moved, so without it nothing landed.
  if (intent.previousHead === undefined) {return yield* rerun(null);}

  const head = yield* git(["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`]);

  if (head === intent.approvedCommit) {return { verdict: "landed", head } as const;}

  const [, ...parents] = (yield* git(["rev-list", "--parents", "-n", "1", head])).split(" ");

  if (parents.length === 2 && parents[0] === intent.previousHead && parents[1] === intent.approvedCommit) {
    return { verdict: "landed", head } as const;
  }

  if (head === intent.previousHead) {return yield* rerun(head);}

  return { verdict: "indeterminate", head, reason: "default branch head is neither the recorded head nor the approved result" } as const;
}).pipe(Effect.catchTag("RecoveryGitFailed", ({ reason }) =>
  Effect.succeed({ verdict: "indeterminate", head: null, reason: `cannot read the default branch: ${reason}` } as const)));

/**
 * Discards what an interrupted run left in the clone before it reruns or completes: the scratch
 * checkout and its temporary directory, and the empty ticket-branch lock the integration took and
 * holds while it runs (Git's own ref locks carry the new value). Best effort.
 */
const discardTemporaryState = (
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, RecoveryGitFailed>,
  scratch: string | null,
  lockPath: string | null,
) => Effect.gen(function* () {
  if (scratch !== null) {
    if (existsSync(scratch)) {yield* git(["worktree", "remove", "--force", scratch]).pipe(Effect.ignore);}

    const directory = dirname(scratch);

    if (basename(directory).startsWith("foundry-integration-")) {
      yield* Effect.sync(() => rmSync(directory, { recursive: true, force: true }));
    }
  }

  yield* git(["worktree", "prune"]).pipe(Effect.ignore);

  if (lockPath === null) {return;}

  yield* Effect.sync(() => {
    if (existsSync(lockPath) && statSync(lockPath).size === 0) {unlinkSync(lockPath);}
  });
});

/**
 * Discards what an interrupted integration left in `clonePath`: its scratch checkout and, if empty,
 * the ticket-branch lock it recorded. Used when the operator declares an indeterminate integration.
 */
export const discardIntegrationLeftovers = (
  clonePath: string,
  env: NodeJS.ProcessEnv,
  scratch: string | null,
  lockPath: string | null,
): Effect.Effect<void> => discardTemporaryState((args) => Effect.tryPromise({
  try: () => runCloneGit(["-c", "core.hooksPath=/dev/null", ...args], env, clonePath),
  catch: (cause) => new RecoveryGitFailed({ reason: messageOf(cause) }),
}), scratch, lockPath);

/** The scratch checkout an integration recorded in its intent, if any. */
export const recordedTemporaryWorktree = (intent: OperationDetail): string | null =>
  temporaryWorktreeOf(Option.getOrUndefined(decodeIntent(intent)));

/** The integration's own setup hook, interrupted with it, goes with its temporary worktree. */
const closeIntegrationHooksIn = (change: Change, hooks: ReadonlyArray<Operation>) => Effect.forEach(hooks, (hook) =>
  recordRecoveryResultIn(change, hook.id, {
    status: "interrupted",
    result: { reason: "discarded with its integration's temporary worktree", integrationOperationId: hook.intent["integrationOperationId"] ?? null },
  }), { discard: true });

interface StageTicket {
  readonly stage: string;
  readonly approved_commit: string;
}

/** The ticket while it still awaits this integration; `undefined` once it moved on. */
const awaitingTicket = (change: Change, operation: Operation, approvalId: number | null) => Effect.map(
  change.query<StageTicket>(`SELECT t.stage, i.approved_commit FROM ticket t
    JOIN integration_intent i ON i.factory_id = t.factory_id AND i.ticket_number = t.number
    WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status = 'awaiting_approval' AND i.approval_id = ?`,
  [operation.factoryId, operation.ticket, approvalId]),
  (rows) => rows[0],
);

const recoverOne = (
  options: IntegrationRecoveryOptions,
  target: SyncTarget,
  operation: Operation,
  hooks: ReadonlyArray<Operation>,
): Effect.Effect<IntegrationRecovery, StoreError> => Effect.gen(function* () {
  const { store } = options;
  const env = options.env ?? process.env;
  const clonePath = target.clonePath;
  const ticketNumber = expectDefined(operation.ticket ?? undefined, `integration ${operation.id} ticket`);

  const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(["-c", "core.hooksPath=/dev/null", ...args], env, clonePath),
    catch: (cause) => new RecoveryGitFailed({ reason: messageOf(cause) }),
  });

  const intent = Option.getOrUndefined(decodeIntent(operation.intent));
  const defaultBranch = intent?.defaultBranch ?? target.defaultBranch;
  const classification = yield* classify(git, clonePath, intent, defaultBranch);
  const temporaryWorktree = temporaryWorktreeOf(intent);
  const now = yield* Clock.currentTimeMillis;

  const [row] = yield* store.read<{ branch: string | null }>(`SELECT branch FROM ticket WHERE factory_id = ? AND number = ?`,
    [operation.factoryId, ticketNumber]);

  const branchLock = yield* branchLockOf(git, clonePath, intent, row?.branch ?? null);

  if (classification.verdict === "rerun") {
    yield* discardTemporaryState(git, temporaryWorktree, branchLock);

    const requeued = yield* store.change((change) => Effect.gen(function* () {
      yield* closeIntegrationHooksIn(change, hooks);

      // `intent` is defined: only a decoded intent can be rerun. The rerun records its head afresh.
      const approved = expectDefined(intent, `integration ${operation.id} intent`);

      return yield* requeueInterruptedOperationIn(change, operation.id, { approvalId: approved.approvalId, approvedCommit: approved.approvedCommit });
    }));

    return { operation: requeued, verdict: "rerun" };
  }

  if (classification.verdict === "landed") {
    const approved = expectDefined(intent, `integration ${operation.id} intent`);

    // The run held the ticket-branch lock until its result committed; cleanup deletes the branch.
    yield* discardTemporaryState(git, temporaryWorktree, branchLock);

    const { recovered, completed } = yield* store.change((change) => Effect.gen(function* () {
      const result = yield* recordRecoveryResultIn(change, operation.id, { status: "complete", result: {
        previousHead: approved.previousHead ?? null, approvedCommit: approved.approvedCommit, head: classification.head,
        fastForward: classification.head === approved.approvedCommit, recovered: true, cleanup: "pending",
      } });

      yield* closeIntegrationHooksIn(change, hooks);
      const ticket = yield* awaitingTicket(change, operation, approved.approvalId);

      if (ticket === undefined) {return { recovered: result, completed: false };}

      yield* change.query(`UPDATE ticket SET state = 'completed', stage = NULL, status = NULL WHERE factory_id = ? AND number = ?`,
        [operation.factoryId, ticketNumber]);
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
        from_state, from_stage, from_status, to_state, to_stage, to_status, reason, git_commit, evidence)
        VALUES (?, ?, ?, 'daemon', 'stage', ?, 'awaiting_approval', 'completed', NULL, NULL, ?, ?, '[]')`,
      [operation.factoryId, ticketNumber, now, ticket.stage, "Integrated approved commit (found landed on recovery)", ticket.approved_commit]);
      yield* change.recordHistory({ factoryId: operation.factoryId, kind: "ticket.transitioned", subject: String(ticketNumber),
        detail: { state: "completed", stage: null, status: null, operationId: operation.id, approvedCommit: ticket.approved_commit, cleanup: "pending" },
        records: [ticketRecord(ticketNumber)] });

      return { recovered: result, completed: true };
    }));

    if (completed && options.worktrees !== undefined) {
      // As after an uninterrupted integration: cleanup owns its own result and never fails this one.
      yield* options.worktrees.clean(operation.factoryId, ticketNumber).pipe(Effect.catchTag("TicketError", () => Effect.void));
    }

    return { operation: recovered, verdict: "landed" };
  }

  const evidence = {
    operationId: operation.id,
    recordedIntent: operation.intent,
    currentHead: classification.head,
    temporaryWorktree,
    branchLock,
    reason: classification.reason,
  };

  const held = yield* store.change((change) => Effect.gen(function* () {
    const result = yield* recordRecoveryResultIn(change, operation.id, { status: "indeterminate", result: evidence });
    yield* closeIntegrationHooksIn(change, hooks);
    const ticket = yield* awaitingTicket(change, operation, intent?.approvalId ?? null);

    // Paused with its approvals and integration intent kept, so the operator's declaration decides.
    if (ticket !== undefined) {
      yield* change.query(`UPDATE ticket SET status = 'paused' WHERE factory_id = ? AND number = ?`, [operation.factoryId, ticketNumber]);
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
        from_state, from_stage, from_status, to_state, to_stage, to_status, reason, git_commit)
        VALUES (?, ?, ?, 'daemon', 'stage', ?, 'awaiting_approval', 'stage', ?, 'paused', ?, ?)`,
      [operation.factoryId, ticketNumber, now, ticket.stage, ticket.stage, `Integration indeterminate: ${classification.reason}`, ticket.approved_commit]);
      yield* change.recordHistory({ factoryId: operation.factoryId, kind: "ticket.transitioned", subject: String(ticketNumber),
        detail: { state: "stage", stage: ticket.stage, status: "paused", operationId: operation.id }, records: [ticketRecord(ticketNumber)] });
    }

    yield* raiseHoldIn(change, { factoryId: operation.factoryId, kind: "indeterminate_integration", subject: String(ticketNumber), evidence });

    return result;
  }));

  return { operation: held, verdict: "indeterminate" };
});

/**
 * Reconciles the factory's interrupted integrations, oldest first, and returns each verdict. A
 * factory with no loaded clone is left as it is, its queue still closed. Other kinds awaiting
 * recovery are left to their own recovery, except an integration's own setup hook.
 */
export const recoverInterruptedIntegrations = (
  options: IntegrationRecoveryOptions,
  factoryId: string,
): Effect.Effect<ReadonlyArray<IntegrationRecovery>, StoreError> => Effect.gen(function* () {
  const target = options.target(factoryId);

  if (target === undefined) {return [];}

  const awaiting = yield* listOperationsAwaitingRecovery(options.store, factoryId);
  const recovered: Array<IntegrationRecovery> = [];

  for (const operation of awaiting.filter((candidate) => candidate.kind === "integration")) {
    const hooks = awaiting.filter((candidate) => candidate.kind === "hook" && isIntegrationHook(candidate.intent) &&
      candidate.intent.integrationOperationId === operation.id);

    const lock = ticketApprovalLock(options.store, factoryId, operation.ticket ?? 0);
    // Each integration recovers on its own: one failure leaves only that one awaiting recovery.
    const exit = yield* Effect.exit(lock.withPermit(recoverOne(options, target, operation, hooks)));

    if (Exit.isSuccess(exit)) {recovered.push(exit.value);}
    else {options.onFailure?.(operation, exit.cause);}
  }

  return recovered;
});
