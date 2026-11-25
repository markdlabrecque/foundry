/** Request replies (PRD §6.5, §10.1). Delegation resolution is a separate arm. */
import { Clock, Effect, Schema } from "effect";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler } from "./submissions.js";

const ReplyArgs = Schema.Struct({ requestId: Schema.NonEmptyString, body: Schema.String });

interface RequestRow {
  readonly requester_slot: string;
  readonly recipient_slot: string | null;
  readonly ticket_number: number | null;
  readonly status: string;
  readonly deadline: number;
}

/** Identity comes from the claimed channel, not the tool arguments. No launch is persisted as
 * the reply destination: the logical requester slot survives replacement launches. */
export const agentReplyHandler = (): ToolHandler => (change, call) => Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(ReplyArgs)(call.args).pipe(
    Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "agent_reply needs requestId and body" })),
  );

  const rows = yield* change.query<RequestRow>(
    `SELECT requester_slot, recipient_slot, ticket_number, status, deadline FROM agent_request WHERE id = ? AND factory_id = ?`,
    [args.requestId, call.factoryId],
  );

  const request = rows[0];

  if (request === undefined) {
    return yield* new ToolRefusal({ code: "unknown_request", detail: "no such request in your factory" });
  }

  if (request.recipient_slot !== call.slotId) {
    return yield* new ToolRefusal({ code: "wrong_recipient", detail: "only the selected recipient slot may reply" });
  }

  const now = yield* Clock.currentTimeMillis;

  const records = [slotRecord(call.slotId), slotRecord(request.requester_slot),
    ...(request.ticket_number === null ? [] : [ticketRecord(request.ticket_number)])];

  // A late attempt must commit its evidence and submission, not throw a refusal which rolls
  // both back. It neither completes nor reopens the request; expiry belongs to the sweep.
  if (now >= request.deadline) {
    yield* change.recordHistory({ factoryId: call.factoryId, kind: "request.reply_late", subject: args.requestId,
      detail: { senderSlot: call.slotId, launchId: call.launchId, callId: call.callId, body: args.body, deadline: request.deadline }, records });

    return { requestId: args.requestId, status: "late" };
  }

  if (request.status !== "open") {
    return yield* new ToolRefusal({ code: "request_closed", detail: "the request is already closed" });
  }

  const reply = yield* acceptMessage(change, {
    factoryId: call.factoryId, senderSlot: call.slotId, recipient: request.requester_slot,
    body: args.body, delivery: "after_turn", kind: "reply",
    correlation: { requestId: args.requestId, ticket: request.ticket_number },
  });

  // Replies target one exact logical slot, never station selection (or a new assignment).
  yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`,
    [request.requester_slot, now, reply.id]);
  yield* change.recordHistory({ factoryId: call.factoryId, kind: "message.bound", subject: reply.id,
    detail: { sequence: reply.sequence, slotId: request.requester_slot }, records });
  yield* change.query(`UPDATE agent_request SET status = 'completed' WHERE id = ? AND factory_id = ?`,
    [args.requestId, call.factoryId]);
  yield* change.recordHistory({ factoryId: call.factoryId, kind: "request.completed", subject: args.requestId,
    detail: { replyId: reply.id, senderSlot: call.slotId, requesterSlot: request.requester_slot }, records });

  return { requestId: args.requestId, status: "completed", replyId: reply.id };
});
