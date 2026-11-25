/**
 * The operator's declaration on an indeterminate integration (PRD §10.2 "Indeterminate
 * integration", §11.3): `foundry integration landed` or `not-landed`. Neither moves or resets the
 * default branch; Git only reads it here.
 *
 * - Landed: refused unless the approved commit is an ancestor of the default branch head. The
 *   integration and ticket complete as a landed integration would, and cleanup follows.
 * - Not landed: the current head is recorded as the new starting point and the integration goes
 *   back on the queue, its approval and approved commit kept, to rerun from the start.
 *
 * Either way the indeterminate-integration hold is resolved in the same change, which reopens the
 * factory's queue; the caller then resumes it.
 */
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { messageOf } from "@foundry/protocol/errors";
import { ticketApprovalLock } from "./approval-coordination.js";
import { runCloneGit } from "./factory-clone.js";
import type { SyncTarget } from "./factory-sync.js";
import { ticketRecord } from "./history-records.js";
import { closeOpenHoldIn } from "./holds.js";
import { brokenClone, discardIntegrationLeftovers, recordedTemporaryWorktree } from "./integration-recovery.js";
import { completeIndeterminateIntegrationIn, getOperation, requeueIndeterminateIntegrationIn } from "./operations.js";
import { TicketError } from "./tickets.js";
import type { Query, Store, StoreError } from "./store.js";
import type { WorktreeService } from "./worktree-cleanup.js";

export type IntegrationDeclaration = "landed" | "not-landed";

export interface DeclareIntegrationOptions {
  readonly store: Store;
  /** The factory's clone; `undefined` while it is not started. */
  readonly target: SyncTarget | undefined;
  /** Git's environment. Default: the process's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Cleanup after a landed integration completes, as after an uninterrupted one. */
  readonly worktrees?: Pick<WorktreeService, "clean"> | undefined;
  readonly configLoad?: string | undefined;
}

const refuse = (code: "invalid_state" | "unavailable", message: string) => Effect.fail(new TicketError({ code, message }));

/** What an indeterminate integration recorded: its intent, and recovery's evidence as its result. */
const DeclaredIntent = Schema.Struct({
  approvalId: Schema.Number,
  approvedCommit: Schema.String,
  previousHead: Schema.optionalKey(Schema.String),
  defaultBranch: Schema.optionalKey(Schema.String),
  branchLock: Schema.optionalKey(Schema.String),
});

const decodeDeclaredIntent = Schema.decodeUnknownOption(DeclaredIntent);

const RecoveryEvidence = Schema.Struct({ branchLock: Schema.optionalKey(Schema.NullOr(Schema.String)) });

const decodeEvidence = Schema.decodeUnknownOption(RecoveryEvidence);

/** The ticket while it is paused on this integration's approval; `undefined` otherwise. */
const pausedTicket = (query: Query, factory: string, number: number, approvalId: number) => Effect.map(
  query<{ stage: string; approved_commit: string }>(`SELECT t.stage, i.approved_commit FROM ticket t
    JOIN integration_intent i ON i.factory_id = t.factory_id AND i.ticket_number = t.number
    JOIN approval a ON a.id = i.approval_id
    WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status = 'paused'
      AND i.approval_id = ? AND a.decision = 'approved'`, [factory, number, approvalId]),
  (rows) => rows[0],
);

export const declareIntegration = (
  options: DeclareIntegrationOptions,
  factory: string,
  number: number,
  declaration: IntegrationDeclaration,
): Effect.Effect<void, TicketError | StoreError> =>
  ticketApprovalLock(options.store, factory, number).withPermit(Effect.gen(function* () {
    const { store, target } = options;
    const env = options.env ?? process.env;

    const [found] = yield* store.read<{ id: number }>(`SELECT id FROM operation WHERE factory_id = ? AND ticket_number = ?
      AND kind = 'integration' AND status = 'indeterminate' ORDER BY id DESC LIMIT 1`, [factory, number]);

    const operation = found === undefined ? undefined : yield* getOperation(store, found.id);

    if (operation === undefined) {return yield* refuse("invalid_state", `Ticket ${number} has no indeterminate integration to declare`);}

    const intent = Option.getOrUndefined(decodeDeclaredIntent(operation.intent));

    if (intent === undefined) {
      return yield* refuse("invalid_state", `Integration ${operation.id} recorded no approved commit to declare`);
    }

    const { approvalId, approvedCommit } = intent;

    if (target === undefined) {return yield* refuse("unavailable", `Factory "${factory}" has no started clone`);}

    const defaultBranch = intent.defaultBranch ?? target.defaultBranch;

    const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
      try: () => runCloneGit(["-c", "core.hooksPath=/dev/null", ...args], env, target.clonePath),
      catch: (cause) => new TicketError({ code: "invalid_state", message: messageOf(cause) }),
    });

    const head = yield* git(["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`]).pipe(
      Effect.mapError((error) => new TicketError({ code: "invalid_state", message: `Cannot read ${defaultBranch}: ${error.message}` })));

    if (declaration === "landed") {
      // Exit status 1 (not an ancestor) and an unknown commit are both a refusal; nothing changes.
      const ancestor = yield* Effect.exit(git(["merge-base", "--is-ancestor", approvedCommit, head]));

      if (Exit.isFailure(ancestor)) {
        return yield* refuse("invalid_state",
          `Approved commit ${approvedCommit} is not an ancestor of ${defaultBranch} (${head}); integration not declared landed`);
      }
    }

    if (declaration === "not-landed") {
      // Refuse before touching the clone, so a refusal leaves the hold's evidence in place. The
      // transaction below checks the ticket again.
      const ticket = yield* pausedTicket(store.read, factory, number, approvalId);

      if (ticket === undefined || ticket.approved_commit !== approvedCommit) {
        return yield* refuse("invalid_state", `Ticket ${number} is not paused with the integration's approval; cannot rerun it`);
      }

      // A rerun into a clone Git died writing would crash mid-run and turn indeterminate again.
      const broken = yield* brokenClone(git, target.clonePath);

      if (broken !== undefined) {
        return yield* refuse("invalid_state", `Repair the factory clone before declaring not landed: ${broken}`);
      }
    }

    // The interrupted run's scratch checkout and empty ticket-branch lock would block cleanup or a rerun.
    const evidence = Option.getOrUndefined(decodeEvidence(operation.result ?? {}));

    yield* discardIntegrationLeftovers(target.clonePath, env,
      recordedTemporaryWorktree(operation.intent), evidence?.branchLock ?? intent.branchLock ?? null);

    const now = yield* Clock.currentTimeMillis;
    const hold = { factoryId: factory, kind: "indeterminate_integration", subject: String(number) } as const;

    if (declaration === "not-landed") {
      yield* store.change((change) => Effect.gen(function* () {
        const ticket = yield* pausedTicket(change.query, factory, number, approvalId);

        if (ticket === undefined || ticket.approved_commit !== approvedCommit) {
          return yield* refuse("invalid_state", `Ticket ${number} is not paused with the integration's approval; cannot rerun it`);
        }

        // The current head is the rerun's new starting point. Kept apart from `previousHead`, which
        // only the run records once it holds the ticket-branch lock, so recovery never reads it as such.
        const requeued = yield* requeueIndeterminateIntegrationIn(change, operation.id,
          { approvalId, approvedCommit, declaredHead: head, declared: "not-landed" });

        if (requeued === undefined) {return yield* refuse("invalid_state", `Integration ${operation.id} is no longer indeterminate`);}

        yield* change.query(`UPDATE ticket SET status = 'awaiting_approval' WHERE factory_id = ? AND number = ?`, [factory, number]);
        yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
          from_status, to_state, to_stage, to_status, reason, git_commit, config_load) VALUES (?, ?, ?, 'operator', 'stage', ?, 'paused',
          'stage', ?, 'awaiting_approval', ?, ?, ?)`,
        [factory, number, now, ticket.stage, ticket.stage, `Integration declared not landed; rerun from ${head}`, approvedCommit, options.configLoad ?? null]);
        yield* closeOpenHoldIn(change, hold, "resolved");
        yield* change.recordHistory({ factoryId: factory, kind: "integration.requested", subject: String(number),
          detail: { operationId: operation.id, approvalId, approvedCommit, declaredHead: head, declared: "not-landed" }, records: [ticketRecord(number)] });
      }));

      return;
    }

    const completed = yield* store.change((change) => Effect.gen(function* () {
      const done = yield* completeIndeterminateIntegrationIn(change, operation.id, {
        previousHead: intent.previousHead ?? null, approvedCommit, head,
        fastForward: head === approvedCommit, declared: "landed", cleanup: "pending",
      });

      if (done === undefined) {return yield* refuse("invalid_state", `Integration ${operation.id} is no longer indeterminate`);}

      yield* closeOpenHoldIn(change, hold, "resolved");
      const ticket = yield* pausedTicket(change.query, factory, number, approvalId);

      if (ticket === undefined) {return false;}

      yield* change.query(`UPDATE ticket SET state = 'completed', stage = NULL, status = NULL WHERE factory_id = ? AND number = ?`, [factory, number]);
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
        from_state, from_stage, from_status, to_state, to_stage, to_status, reason, git_commit, evidence, config_load)
        VALUES (?, ?, ?, 'operator', 'stage', ?, 'paused', 'completed', NULL, NULL, ?, ?, '[]', ?)`,
      [factory, number, now, ticket.stage, "Integrated approved commit (declared landed)", ticket.approved_commit, options.configLoad ?? null]);
      yield* change.recordHistory({ factoryId: factory, kind: "ticket.transitioned", subject: String(number),
        detail: { state: "completed", stage: null, status: null, operationId: operation.id, approvedCommit: ticket.approved_commit, cleanup: "pending" },
        records: [ticketRecord(number)] });

      return true;
    }));

    if (completed && options.worktrees !== undefined) {
      // As after an uninterrupted integration: cleanup owns its own result and never fails this one.
      yield* options.worktrees.clean(factory, number).pipe(Effect.catchTag("TicketError", () => Effect.void));
    }
  }));
