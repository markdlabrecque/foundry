/** Dropping a delegation notice abandons the delegation and tells the delegating slot (PRD §10.2). */
import { Clock, Effect } from "effect";
import type { MessageDispositionResult } from "@foundry/protocol/messages-api";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { Change, StoreError } from "./store.js";

/**
 * Runs inside the drop's transaction, so the abandonment, its notification and the drop commit
 * together. Only an open delegation is abandoned: one already completed, abandoned or cancelled
 * keeps that outcome, and the delegating slot hears nothing new. §10.2 closes only the named
 * delegation, so its child delegations are deliberately not cascaded (cascading awaits a product
 * decision).
 */
export const abandonDroppedDelegation = (change: Change, notice: MessageDispositionResult): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const [abandoned] = yield* change.query<{ id: string; delegating_slot: string; root_assignment: string }>(
      `UPDATE delegation SET status = 'abandoned' WHERE factory_id = ? AND notice_id = ? AND status = 'open'
       RETURNING id, delegating_slot, root_assignment`, [notice.factoryId, notice.id],
    );

    if (abandoned === undefined) {return;}

    const [assignment] = yield* change.query<{ ticket_number: number }>(
      `SELECT ticket_number FROM assignment WHERE id = ? AND factory_id = ?`, [abandoned.root_assignment, notice.factoryId],
    );

    const ticket = assignment?.ticket_number ?? null;
    const now = yield* Clock.currentTimeMillis;
    const records = [slotRecord(abandoned.delegating_slot), ...(ticket === null ? [] : [ticketRecord(ticket)])];

    // Daemon-written (no budget), bound to the exact delegating slot as a completion reply would be.
    const message = yield* acceptMessage(change, {
      factoryId: notice.factoryId, senderKind: "daemon", senderSlot: null, recipient: abandoned.delegating_slot,
      kind: "ordinary", delivery: "after_turn", correlation: { delegationId: abandoned.id, ticket },
      body: `Delegation ${abandoned.id} was abandoned: the operator dropped its notice ${notice.id} because its delivery could not be confirmed. No reply will arrive.`,
    }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

    yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`,
      [abandoned.delegating_slot, now, message.id]);
    yield* change.recordHistory({ factoryId: notice.factoryId, kind: "message.bound", subject: message.id,
      detail: { sequence: message.sequence, slotId: abandoned.delegating_slot }, records });
    yield* change.recordHistory({ factoryId: notice.factoryId, kind: "delegation.abandoned", subject: abandoned.id,
      detail: { reason: "notice_dropped", noticeId: notice.id, delegatingSlot: abandoned.delegating_slot, notificationId: message.id },
      records });
  });
