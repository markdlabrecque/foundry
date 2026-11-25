/** Dropping a delegation notice abandons the delegation and tells the delegating slot (PRD §10.2). */
import { Clock, Effect } from "effect";
import type { MessageDispositionResult } from "@foundry/protocol/messages-api";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { Change } from "./store.js";

/** Runs inside the drop's transaction, so abandonment, notification and drop commit together.
 * Only an open delegation is abandoned: one already closed keeps its result and nobody is told. */
export const abandonDroppedDelegation = (change: Change, notice: MessageDispositionResult) => Effect.gen(function* () {
  const rows = yield* change.query<{ id: string; delegating_slot: string; station: string | null; ticket_number: number }>(
    `SELECT d.id, d.delegating_slot, s.station, a.ticket_number FROM delegation d
     JOIN assignment a ON a.id = d.root_assignment AND a.factory_id = d.factory_id
     LEFT JOIN slot s ON s.factory_id = d.factory_id AND s.slot_id = d.delegating_slot
     WHERE d.notice_id = ? AND d.factory_id = ? AND d.status = 'open'`,
    [notice.id, notice.factoryId],
  );

  const delegation = rows[0];

  if (delegation === undefined) {return;}

  const now = yield* Clock.currentTimeMillis;
  const records = [slotRecord(delegation.delegating_slot), ticketRecord(delegation.ticket_number)];
  yield* change.query(`UPDATE delegation SET status = 'abandoned' WHERE id = ? AND status = 'open'`, [delegation.id]);

  const message = yield* acceptMessage(change, {
    factoryId: notice.factoryId, senderKind: "daemon", senderSlot: null,
    recipient: delegation.station ?? delegation.delegating_slot, kind: "ordinary", delivery: "after_turn",
    correlation: { delegationId: delegation.id, ticket: delegation.ticket_number },
    body: `Ticket ${delegation.ticket_number}: delegation ${delegation.id} was abandoned. The operator dropped its notice ${notice.id}, so no reply will come.`,
  }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

  yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`,
    [delegation.delegating_slot, now, message.id]);
  yield* change.recordHistory({ factoryId: notice.factoryId, kind: "message.bound", subject: message.id,
    detail: { sequence: message.sequence, slotId: delegation.delegating_slot }, records });
  yield* change.recordHistory({ factoryId: notice.factoryId, kind: "delegation.abandoned", subject: delegation.id,
    detail: { cause: "notice_dropped", noticeId: notice.id, delegatingSlot: delegation.delegating_slot, notificationId: message.id },
    records });
});
