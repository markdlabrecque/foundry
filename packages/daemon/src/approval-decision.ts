/** Operator-only gate resolution. Worker submissions and messages never receive this capability. */
import { Clock, Data, Effect } from "effect";
import type { ApprovalDecisionResult } from "@foundry/protocol/approvals";
import { expectDefined } from "@foundry/protocol/errors";
import type { AssignmentFactory } from "./assignments.js";
import { ticketRecord } from "./history-records.js";
import { enqueueOperationIn } from "./operations.js";
import { inspectCode } from "./code-observation.js";
import { voidStaleApprovals } from "./approval-voiding.js";
import { outcomeRoute } from "./outcome-route.js";
import type { Store, StoreError } from "./store.js";

export class ApprovalDecisionError extends Data.TaggedError("ApprovalDecisionError")<{
  readonly code: "not_found" | "invalid_state" | "invalid_request";
  readonly message: string;
}> {}

export interface ApprovalDecisions {
  readonly resolve: (id: number, decision: "approved" | "rejected", reason?: string) =>
    Effect.Effect<ApprovalDecisionResult, ApprovalDecisionError | StoreError>;
}

interface GateRow {
  readonly factory_id: string;
  readonly ticket_number: number;
  readonly kind: string;
  readonly state: string;
  readonly production_line: string;
  readonly stage: string;
  readonly ticket_state: string;
  readonly status: string;
  readonly evaluated_stage: string;
  readonly git_commit: string | null;
  readonly evidence: string;
  readonly rejections: number;
  readonly rejection_ceiling: number;
}

export interface ApprovalDecisionOptions {
  readonly store: Store;
  readonly factories: ReadonlyArray<AssignmentFactory>;
  readonly configLoad?: (factory: string) => string | undefined;
  /** Wake the durable queue only after the approval transaction commits. */
  readonly onIntegrationQueued?: () => void;
}

export const createApprovalDecisions = (options: ApprovalDecisionOptions): ApprovalDecisions => ({
  resolve: (id, decision, reason) => Effect.gen(function* () {
    const [ticket] = yield* options.store.read<{ factory_id: string; number: number; worktree_path: string | null; branch: string | null }>(
      `SELECT t.factory_id, t.number, t.worktree_path, t.branch FROM approval a
       JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number WHERE a.id = ?`, [id]);

    const observation = ticket !== undefined && ticket.worktree_path !== null && ticket.branch !== null
      ? yield* inspectCode(ticket.worktree_path, ticket.branch).pipe(Effect.mapError((cause) => new ApprovalDecisionError({ code: "invalid_state", message: cause.detail })))
      : undefined;

    if (ticket !== undefined) {
      yield* voidStaleApprovals(options, { factory: ticket.factory_id, ticket: ticket.number }).pipe(
        Effect.mapError(() => new ApprovalDecisionError({ code: "invalid_state", message: "Could not verify approval HEAD; retry" })),
      );
    }

    return yield* options.store.change((change) => Effect.gen(function* () {
    if (!Number.isSafeInteger(id) || id < 1 || (decision === "rejected" && (reason === undefined || reason.trim() === ""))) {
      return yield* new ApprovalDecisionError({ code: "invalid_request", message: "reject requires a non-empty reason and an approval ID" });
    }

    const rows = yield* change.query<GateRow>(
      `SELECT a.factory_id, a.ticket_number, a.kind, a.state, t.production_line, t.stage,
         t.state AS ticket_state, t.status, tr.from_stage AS evaluated_stage, tr.git_commit, tr.evidence,
         t.rejections, t.rejection_ceiling
       FROM approval a JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
       LEFT JOIN ticket_transition tr ON tr.sequence = a.transition_sequence WHERE a.id = ?`, [id],
    );

    const gate = rows[0];

    if (gate === undefined) {return yield* new ApprovalDecisionError({ code: "not_found", message: `no approval ${id}` });}

    if (gate.kind !== "stage_gate" || gate.state !== "open" || gate.ticket_state !== "stage" ||
      gate.status !== "awaiting_approval" || gate.stage !== gate.evaluated_stage || gate.git_commit === null) {
      return yield* new ApprovalDecisionError({ code: "invalid_state", message: "only an open stage gate on its awaiting-approval ticket can be approved or rejected" });
    }

    const stages = options.factories.find((factory) => factory.factoryId === gate.factory_id)?.config
      .production_lines[gate.production_line]?.stages;

    const index = stages?.findIndex((stage) => stage.id === gate.stage) ?? -1;
    const stage = index < 0 ? undefined : stages?.[index];

    if (stage === undefined || !stage.approval) {
      return yield* new ApprovalDecisionError({ code: "invalid_state", message: "the gated stage is not configured" });
    }

    if (observation === undefined || observation.head !== gate.git_commit || observation.branch !== `refs/heads/${ticket?.branch}`) {
      return yield* new ApprovalDecisionError({ code: "invalid_state", message: "The approval no longer evaluates the current ticket branch head" });
    }

    yield* observation.validate().pipe(Effect.mapError((cause) => new ApprovalDecisionError({ code: "invalid_state", message: cause.detail })));

    const integrationRequested = decision === "approved" && index === (stages?.length ?? 0) - 1;
    const target = outcomeRoute(stages ?? [], gate.stage, decision === "approved" ? "done" : "rejected");
    const unroutable = decision === "rejected" && target === undefined;
    const limitReached = decision === "rejected" && target !== undefined && gate.rejections + 1 >= gate.rejection_ceiling;
    const status = integrationRequested ? "awaiting_approval" : unroutable || limitReached ? "paused" : "queued";
    const nextStage = target ?? gate.stage;
    const now = yield* Clock.currentTimeMillis;

    yield* change.query(`UPDATE ticket SET stage = ?, status = ?, rejections = rejections + ? WHERE factory_id = ? AND number = ?`,
      [nextStage, status, decision === "rejected" && !unroutable ? 1 : 0, gate.factory_id, gate.ticket_number]);

    const transitions = yield* change.query<{ sequence: number }>(
      `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
         from_state, from_stage, from_status, to_state, to_stage, to_status, outcome, reason, git_commit, evidence, config_load)
       VALUES (?, ?, ?, 'operator', 'stage', ?, 'awaiting_approval', 'stage', ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
      [gate.factory_id, gate.ticket_number, now, gate.stage, nextStage, status,
        decision === "approved" ? "done" : "rejected", reason ?? "Operator approved", gate.git_commit, gate.evidence,
        options.configLoad?.(gate.factory_id) ?? null],
    );

    const transition = expectDefined(transitions[0], "operator transition").sequence;
    yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = ?, decision = ?, resolution_transition = ? WHERE id = ?`,
      [now, decision, transition, id]);

    if (unroutable || limitReached) {
      // The ended assignment stays ended; resume/retry owns any subsequent assignment lifecycle.
      const approvals = yield* change.query<{ id: number }>(`INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
        SELECT factory_id, ticket_number, assignment_id, ?, ?, 'open', ? FROM approval WHERE id = ? RETURNING id`,
        [transition, limitReached ? "limit_reached" : "blocked", now, id]);

      const blockedId = expectDefined(approvals[0], "operator decision follow-up approval").id;

      yield* change.recordHistory({ factoryId: gate.factory_id, kind: "approval.requested", subject: String(blockedId),
        detail: { kind: limitReached ? "limit_reached" : "blocked", ticket: gate.ticket_number, transition }, records: [ticketRecord(gate.ticket_number)] });
    }

    if (integrationRequested) {
      yield* change.query(`INSERT INTO integration_intent (approval_id, factory_id, ticket_number, approved_commit, transition_sequence, requested_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [id, gate.factory_id, gate.ticket_number, gate.git_commit, transition, now]);
      yield* enqueueOperationIn(change, { factoryId: gate.factory_id, kind: "integration", ticket: gate.ticket_number,
        intent: { approvalId: id, approvedCommit: gate.git_commit, transition } });
      yield* change.recordHistory({ factoryId: gate.factory_id, kind: "integration.requested", subject: String(gate.ticket_number),
        detail: { approvalId: id, approvedCommit: gate.git_commit, transition }, records: [ticketRecord(gate.ticket_number)] });
    }

    yield* change.recordHistory({ factoryId: gate.factory_id, kind: "approval.resolved", subject: String(id),
      detail: { decision, transition, commit: gate.git_commit }, records: [ticketRecord(gate.ticket_number)] });
    yield* change.recordHistory({ factoryId: gate.factory_id, kind: "ticket.transitioned", subject: String(gate.ticket_number),
      detail: { fromStage: gate.stage, stage: nextStage, status, approvalId: id }, records: [ticketRecord(gate.ticket_number)] });

    yield* observation.validate().pipe(Effect.mapError((cause) => new ApprovalDecisionError({ code: "invalid_state", message: cause.detail })));

    return { approvalId: id, decision, transition, commit: gate.git_commit, integrationRequested };
    }));
  }).pipe(Effect.tap((result) => Effect.sync(() => {
    if (result.integrationRequested) {options.onIntegrationQueued?.();}
  }))),
});
