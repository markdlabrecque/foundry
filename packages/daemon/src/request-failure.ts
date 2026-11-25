/** Dropping a request notice fails the request to its requester at once (PRD §10.2). */
import { Clock, Effect } from "effect";
import type { MessageDispositionResult } from "@foundry/protocol/messages-api";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { Change, StoreError } from "./store.js";

/**
 * Runs inside the drop's transaction, so the failure, its notification and the drop commit
 * together. Only an open request fails: one already completed, expired or closed by its
 * assignment keeps that outcome, and the requester hears nothing new.
 */
export const failDroppedRequest = (change: Change, notice: MessageDispositionResult): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const [request] = yield* change.query<{ id: string; requester_slot: string; ticket_number: number | null }>(
      `UPDATE agent_request SET status = 'failed' WHERE factory_id = ? AND notice_id = ? AND status = 'open'
       RETURNING id, requester_slot, ticket_number`, [notice.factoryId, notice.id],
    );

    if (request === undefined) {return;}

    const now = yield* Clock.currentTimeMillis;
    const records = [slotRecord(request.requester_slot), ...(request.ticket_number === null ? [] : [ticketRecord(request.ticket_number)])];

    // Daemon-written (no budget), bound to the exact requester slot as a reply would be.
    const message = yield* acceptMessage(change, {
      factoryId: notice.factoryId, senderKind: "daemon", senderSlot: null, recipient: request.requester_slot,
      kind: "ordinary", delivery: "after_turn", correlation: { requestId: request.id, ticket: request.ticket_number },
      body: `Request ${request.id} failed: the operator dropped its notice ${notice.id} because its delivery could not be confirmed. No reply will arrive.`,
    }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

    yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`,
      [request.requester_slot, now, message.id]);
    yield* change.recordHistory({ factoryId: notice.factoryId, kind: "message.bound", subject: message.id,
      detail: { sequence: message.sequence, slotId: request.requester_slot }, records });
    yield* change.recordHistory({ factoryId: notice.factoryId, kind: "request.failed", subject: request.id,
      detail: { reason: "notice_dropped", noticeId: notice.id, notificationId: message.id }, records });
  });
