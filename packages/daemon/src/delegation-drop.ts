/** Dropping a delegation notice abandons its open subtree and tells affected slots (PRD §10.2). */
import { Clock, Effect } from "effect";
import type { MessageDispositionResult } from "@foundry/protocol/messages-api";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { closeOpenHoldIn } from "./holds.js";
import type { Change, Query, StoreError } from "./store.js";

interface Descendant {
  readonly id: string;
  readonly delegating_slot: string;
  readonly recipient_slot: string | null;
  readonly notice_id: string;
}

/** Shared by inspection and the drop transaction. Walk closed intermediates, but return only open
 * work in this factory. Do not use root_assignment: other subtrees must remain untouched. */
export const openDelegationDescendants = (query: Query, factoryId: string, rootId: string) =>
  query<Descendant>(`WITH RECURSIVE sub(id) AS (
    SELECT id FROM delegation WHERE parent_id = ? AND factory_id = ?
    UNION ALL
    SELECT d.id FROM delegation d JOIN sub ON d.parent_id = sub.id WHERE d.factory_id = ?
  ) SELECT id, delegating_slot, recipient_slot, notice_id FROM delegation
    WHERE id IN (SELECT id FROM sub) AND factory_id = ? AND status = 'open' ORDER BY id`,
  [rootId, factoryId, factoryId, factoryId]);

/**
 * Runs inside the drop's Change: root, open descendants, undelivered notices, holds, notifications
 * and history commit together. Closed outcomes are preserved (including a closed root, which
 * causes no cascade). Notify the root recipient only if open descendants were abandoned: without
 * them delivery is still unproven, so the existing delegator-only behavior stays unchanged.
 */
export const abandonDroppedDelegation = (change: Change, notice: MessageDispositionResult): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    const [abandoned] = yield* change.query<{ id: string; delegating_slot: string; recipient_slot: string | null; root_assignment: string }>(
      `UPDATE delegation SET status = 'abandoned' WHERE factory_id = ? AND notice_id = ? AND status = 'open'
       RETURNING id, delegating_slot, recipient_slot, root_assignment`, [notice.factoryId, notice.id],
    );

    if (abandoned === undefined) {return;}

    // Re-read in the action transaction; the earlier CLI inspection is not a state lock.
    const descendants = yield* openDelegationDescendants(change.query, notice.factoryId, abandoned.id);
    const descendantIds = descendants.map((row) => row.id);

    const [assignment] = yield* change.query<{ ticket_number: number }>(
      `SELECT ticket_number FROM assignment WHERE id = ? AND factory_id = ?`, [abandoned.root_assignment, notice.factoryId],
    );

    const ticket = assignment?.ticket_number ?? null;
    const recordsFor = (slot: string) => [slotRecord(slot), ...(ticket === null ? [] : [ticketRecord(ticket)])];

    for (const descendant of descendants) {
      yield* change.query(`UPDATE delegation SET status = 'abandoned' WHERE id = ? AND factory_id = ? AND status = 'open'`,
        [descendant.id, notice.factoryId]);

      const dropped = yield* change.query<{ id: string }>(`UPDATE message SET status = 'dropped'
        WHERE id = ? AND factory_id = ? AND status IN ('unbound', 'bound', 'indeterminate') RETURNING id`,
      [descendant.notice_id, notice.factoryId]);

      if (dropped.length > 0) {
        yield* closeOpenHoldIn(change, { factoryId: notice.factoryId, kind: "indeterminate_message", subject: descendant.notice_id }, "resolved");
        yield* closeOpenHoldIn(change, { factoryId: notice.factoryId, kind: "stuck_worker", subject: descendant.notice_id }, "cleared");
        yield* change.recordHistory({ factoryId: notice.factoryId, kind: "message.dropped", subject: descendant.notice_id,
          detail: { reason: "ancestor_dropped", noticeId: notice.id, ancestorId: abandoned.id }, records: recordsFor(descendant.delegating_slot) });
      }

      yield* change.recordHistory({ factoryId: notice.factoryId, kind: "delegation.abandoned", subject: descendant.id,
        detail: { reason: "ancestor_dropped", noticeId: notice.id, ancestorId: abandoned.id }, records: recordsFor(descendant.delegating_slot) });
    }

    const recipients = new Set([abandoned.delegating_slot]);

    if (descendants.length > 0) {
      if (abandoned.recipient_slot !== null) {recipients.add(abandoned.recipient_slot);}

      for (const descendant of descendants) {
        recipients.add(descendant.delegating_slot);

        if (descendant.recipient_slot !== null) {recipients.add(descendant.recipient_slot);}
      }
    }

    const now = yield* Clock.currentTimeMillis;
    let notificationId: string | undefined;

    for (const slot of recipients) {
      // Daemon-written (no budget), bound to the exact affected slot, once even if it has many roles.
      const message = yield* acceptMessage(change, {
        factoryId: notice.factoryId, senderKind: "daemon", senderSlot: null, recipient: slot,
        kind: "ordinary", delivery: "after_turn", correlation: { delegationId: abandoned.id, ticket },
        body: `Delegation ${abandoned.id} was abandoned: the operator dropped its notice ${notice.id} because its delivery could not be confirmed. No reply will arrive.${descendants.length === 0 ? "" : `\nAbandoned descendant delegations: ${descendantIds.join(", ")}`}`,
      }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

      if (slot === abandoned.delegating_slot) {notificationId = message.id;}

      yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`, [slot, now, message.id]);
      yield* change.recordHistory({ factoryId: notice.factoryId, kind: "message.bound", subject: message.id,
        detail: { sequence: message.sequence, slotId: slot }, records: recordsFor(slot) });
    }

    yield* change.recordHistory({ factoryId: notice.factoryId, kind: "delegation.abandoned", subject: abandoned.id,
      detail: { reason: "notice_dropped", noticeId: notice.id, delegatingSlot: abandoned.delegating_slot,
        notificationId, descendants: descendantIds }, records: recordsFor(abandoned.delegating_slot) });
  });
