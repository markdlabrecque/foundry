/** Delegation resolution is independent of request deadlines (PRD §6.5). */
import { Clock, Effect, Schema } from "effect";
import { acceptMessage } from "./agent-message.js";
import type { MessageAcceptanceGuards } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";
import type { Change } from "./store.js";
import type { ToolCallContext } from "./submissions.js";

export const DelegationReplyArgs = Schema.Struct({
  delegationId: Schema.NonEmptyString,
  requestId: Schema.optional(Schema.Never),
  outcome: Schema.NonEmptyString,
  evidence: Schema.NonEmptyString,
});

interface DelegationRow {
  readonly delegating_slot: string;
  readonly recipient_slot: string | null;
  readonly ticket_number: number;
  readonly status: string;
}

export const resolveDelegation = (change: Change, call: ToolCallContext, args: typeof DelegationReplyArgs.Type, guards: MessageAcceptanceGuards = {}) => Effect.gen(function* () {
  const rows = yield* change.query<DelegationRow>(
    `SELECT d.delegating_slot, d.recipient_slot, d.status, a.ticket_number FROM delegation d
     JOIN assignment a ON a.id = d.root_assignment AND a.factory_id = d.factory_id
     WHERE d.id = ? AND d.factory_id = ?`,
    [args.delegationId, call.factoryId],
  );

  const delegation = rows[0];

  if (delegation === undefined) {
    return yield* new ToolRefusal({ code: "unknown_delegation", detail: "no such delegation in your factory" });
  }

  if (delegation.recipient_slot !== call.slotId) {
    return yield* new ToolRefusal({ code: "wrong_recipient", detail: "only the selected recipient slot may resolve a delegation" });
  }

  if (delegation.status !== "open") {
    return yield* new ToolRefusal({ code: "delegation_closed", detail: "the delegation is already closed" });
  }

  const now = yield* Clock.currentTimeMillis;
  const records = [slotRecord(call.slotId), slotRecord(delegation.delegating_slot), ticketRecord(delegation.ticket_number)];

  const reply = yield* acceptMessage(change, {
    factoryId: call.factoryId, senderSlot: call.slotId, recipient: delegation.delegating_slot,
    body: JSON.stringify({ outcome: args.outcome, evidence: args.evidence }), delivery: "after_turn", kind: "reply",
    correlation: { delegationId: args.delegationId, ticket: delegation.ticket_number },
  }, guards);

  yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`,
    [delegation.delegating_slot, now, reply.id]);
  yield* change.recordHistory({ factoryId: call.factoryId, kind: "message.bound", subject: reply.id,
    detail: { sequence: reply.sequence, slotId: delegation.delegating_slot }, records });
  yield* change.query(`UPDATE delegation SET status = 'completed' WHERE id = ? AND factory_id = ?`,
    [args.delegationId, call.factoryId]);
  yield* change.recordHistory({ factoryId: call.factoryId, kind: "delegation.completed", subject: args.delegationId,
    detail: { replyId: reply.id, senderSlot: call.slotId, delegatingSlot: delegation.delegating_slot,
      outcome: args.outcome, evidence: args.evidence }, records });

  return { delegationId: args.delegationId, status: "completed", replyId: reply.id };
});
