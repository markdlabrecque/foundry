/** A worker decision request records an approval, never a ticket transition (PRD §8.2). */
import { Clock, Effect, Schema } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler } from "./submissions.js";

const RequestArgs = Schema.Struct({
  assignmentId: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
});

/** The claimed channel supplies factory and slot authority; stale assignments cannot submit. */
export const humanRequestHandler: ToolHandler = (change, call) => Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(RequestArgs)(call.args, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "human_request needs assignmentId and a non-empty body" })),
  );

  const rows = yield* change.query<{ ticket_number: number; stage: string }>(
    `SELECT a.ticket_number, a.stage FROM assignment a
     JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
     WHERE a.id = ? AND a.factory_id = ? AND a.slot_id = ? AND a.status = 'active'
       AND t.state = 'stage' AND t.status = 'assigned' AND t.stage = a.stage`,
    [args.assignmentId, call.factoryId, call.slotId],
  );

  const assignment = rows[0];

  if (assignment === undefined) {
    return yield* new ToolRefusal({ code: "not_assignment_owner", detail: "only the active assignment's slot may request an operator decision" });
  }

  const now = yield* Clock.currentTimeMillis;

  const approvals = yield* change.query<{ id: number }>(
    `INSERT INTO approval (factory_id, ticket_number, assignment_id, kind, state, raised_at, request_body, request_stage)
     VALUES (?, ?, ?, 'worker_request', 'open', ?, ?, ?) RETURNING id`,
    [call.factoryId, assignment.ticket_number, args.assignmentId, now, args.body, assignment.stage],
  );

  const approvalId = expectDefined(approvals[0], "the worker-request approval").id;
  yield* change.recordHistory({
    factoryId: call.factoryId, kind: "approval.requested", subject: String(approvalId),
    detail: { kind: "worker_request", ticket: assignment.ticket_number, assignment: args.assignmentId },
    records: [ticketRecord(assignment.ticket_number), slotRecord(call.slotId)],
  });

  return { approvalId, assignmentId: args.assignmentId, ticket: assignment.ticket_number };
});
