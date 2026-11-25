/** Retry only a setup-failed integration, retaining its exact-SHA approval. */
import { Clock, Effect } from "effect";
import { ticketApprovalLock } from "./approval-coordination.js";
import { closeOpenHoldIn } from "./holds.js";
import { ticketRecord } from "./history-records.js";
import { enqueueOperationIn } from "./operations.js";
import { TicketError } from "./tickets.js";
import type { Store } from "./store.js";

export const retryIntegration = (store: Store, factory: string, number: number, configLoad?: string) =>
  ticketApprovalLock(store, factory, number).withPermit(store.change((change) => Effect.gen(function* () {
    const [row] = yield* change.query<{ approval_id: number; approved_commit: string; stage: string }>(`SELECT i.approval_id, i.approved_commit, t.stage
      FROM integration_intent i JOIN ticket t ON t.factory_id = i.factory_id AND t.number = i.ticket_number
      JOIN approval a ON a.id = i.approval_id
      WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status = 'paused' AND a.decision = 'approved'
      AND EXISTS (SELECT 1 FROM operator_hold h WHERE h.factory_id = t.factory_id AND h.kind = 'hook_failure'
        AND h.subject = CAST(t.number AS TEXT) AND h.state = 'open' AND json_extract(h.evidence, '$.operation') = 'integration')
      AND NOT EXISTS (SELECT 1 FROM operation o WHERE o.factory_id = t.factory_id AND o.ticket_number = t.number
        AND o.kind = 'integration' AND o.status IN ('queued', 'running', 'interrupted', 'indeterminate'))`, [factory, number]);

    if (row === undefined) {return yield* new TicketError({ code: "invalid_state", message: "Integration retry requires a paused integration after_create failure with a valid approval" });}

    const now = yield* Clock.currentTimeMillis;
    yield* change.query(`UPDATE ticket SET status = 'awaiting_approval' WHERE factory_id = ? AND number = ?`, [factory, number]);
    yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
      from_status, to_state, to_stage, to_status, reason, config_load) VALUES (?, ?, ?, 'operator', 'stage', ?, 'paused',
      'stage', ?, 'awaiting_approval', 'Retry integration setup', ?)`, [factory, number, now, row.stage, row.stage, configLoad ?? null]);
    yield* closeOpenHoldIn(change, { factoryId: factory, kind: "hook_failure", subject: String(number) }, "resolved");

    const operation = yield* enqueueOperationIn(change, { factoryId: factory, ticket: number, kind: "integration",
      intent: { approvalId: row.approval_id, approvedCommit: row.approved_commit } });

    yield* change.recordHistory({ factoryId: factory, kind: "integration.requested", subject: String(number),
      detail: { operationId: operation.id, approvalId: row.approval_id, approvedCommit: row.approved_commit, retry: true }, records: [ticketRecord(number)] });
  })));
