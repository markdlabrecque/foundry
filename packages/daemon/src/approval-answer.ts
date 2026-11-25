/** Resolve a worker request and commit its exact-slot operator answer together (PRD §8.2). */
import { Clock, Data, Effect } from "effect";
import type { ApprovalAnswerResult } from "@foundry/protocol/approvals";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { PlannedSlot } from "./slots.js";
import type { Store, StoreError } from "./store.js";
import type { ToolRefusal } from "./submissions.js";

export class ApprovalAnswerError extends Data.TaggedError("ApprovalAnswerError")<{
  readonly code: "not_found" | "wrong_kind" | "already_resolved" | "recipient_unavailable";
  readonly message: string;
}> {}

export interface ApprovalAnswers {
  readonly answer: (id: number, body: string) => Effect.Effect<ApprovalAnswerResult, StoreError | ToolRefusal | ApprovalAnswerError>;
}

export const createApprovalAnswers = (store: Store, slots: ReadonlyArray<PlannedSlot>): ApprovalAnswers => ({
  answer: (id, body) => store.change((change) => Effect.gen(function* () {
    const rows = yield* change.query<{ factory_id: string; ticket_number: number; kind: string; state: string; slot_id: string }>(
      `SELECT a.factory_id, a.ticket_number, a.kind, a.state, s.slot_id FROM approval a
       JOIN assignment s ON s.id = a.assignment_id WHERE a.id = ?`, [id],
    );

    const approval = rows[0];

    if (approval === undefined) {return yield* new ApprovalAnswerError({ code: "not_found", message: `no approval ${id}` });}

    if (approval.kind !== "worker_request") {return yield* new ApprovalAnswerError({ code: "wrong_kind", message: "answer is only for worker requests" });}

    if (approval.state !== "open") {return yield* new ApprovalAnswerError({ code: "already_resolved", message: `approval ${id} is already resolved` });}

    const slot = slots.find((s) => s.factoryId === approval.factory_id && s.slotId === approval.slot_id);

    if (slot === undefined) {return yield* new ApprovalAnswerError({ code: "recipient_unavailable", message: "the requesting slot is no longer configured" });}

    const now = yield* Clock.currentTimeMillis;

    const message = yield* acceptMessage(change, {
      factoryId: approval.factory_id, senderKind: "operator", senderSlot: null,
      recipient: slot.station.address, body, delivery: "after_turn", kind: "ordinary",
      correlation: { ticket: approval.ticket_number },
    });

    // Bind now: later routing must never substitute a sibling or the ticket's new assignment.
    yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`,
      [slot.slotId, now, message.id]);
    yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = ? WHERE id = ?`, [now, id]);
    const records = [ticketRecord(approval.ticket_number), slotRecord(slot.slotId)];
    yield* change.recordHistory({ factoryId: approval.factory_id, kind: "message.bound", subject: message.id,
      detail: { sequence: message.sequence, slotId: slot.slotId }, records });
    yield* change.recordHistory({ factoryId: approval.factory_id, kind: "approval.answered", subject: String(id),
      detail: { messageId: message.id, slotId: slot.slotId }, records });

    return { approvalId: id, messageId: message.id, slotId: slot.slotId };
  })),
});
