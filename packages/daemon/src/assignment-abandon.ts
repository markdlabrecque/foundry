/** Close a suspended assignment's obligations only when a replacement can actually take it. */
import { Effect } from "effect";
import { acceptMessage } from "./agent-message.js";
import type { PlannedSlot } from "./slots.js";
import type { Change } from "./store.js";

export const abandonAssignment = (change: Change, input: {
  readonly id: string; readonly factoryId: string; readonly ticket: number; readonly now: number;
  readonly slots: ReadonlyArray<PlannedSlot>;
}) => Effect.gen(function* () {
  const delegations = yield* change.query<{ id: string; delegating_slot: string; recipient_slot: string | null; notice_id: string }>(
    `SELECT id, delegating_slot, recipient_slot, notice_id FROM delegation WHERE root_assignment = ? AND status = 'open'`, [input.id],
  );

  const requests = yield* change.query<{ id: string; requester_slot: string; recipient_slot: string | null; notice_id: string }>(
    `SELECT id, requester_slot, recipient_slot, notice_id FROM agent_request WHERE factory_id = ? AND ticket_number = ? AND status = 'open'`,
    [input.factoryId, input.ticket],
  );

  yield* change.query(`UPDATE delegation SET status = 'abandoned' WHERE root_assignment = ? AND status = 'open'`, [input.id]);
  // Requests use the existing terminal failure state: no reply can complete abandoned work.
  yield* change.query(`UPDATE agent_request SET status = 'failed' WHERE factory_id = ? AND ticket_number = ? AND status = 'open'`, [input.factoryId, input.ticket]);

  for (const work of [...delegations, ...requests]) {
    yield* change.query(`UPDATE message SET status = 'dropped' WHERE id = ? AND status IN ('unbound', 'bound')`, [work.notice_id]);
  }

  const recipients = new Set([
    ...delegations.flatMap((row) => [row.delegating_slot, row.recipient_slot]),
    ...requests.flatMap((row) => [row.requester_slot, row.recipient_slot]),
  ]);

  for (const slotId of recipients) {
    const slot = input.slots.find((planned) => planned.factoryId === input.factoryId && planned.slotId === slotId);

    if (slot === undefined) {continue;}

    const message = yield* acceptMessage(change, {
      factoryId: input.factoryId, senderKind: "daemon", senderSlot: null, recipient: slot.station.address,
      kind: "ordinary", delivery: "after_turn", correlation: { ticket: input.ticket },
      body: `Ticket ${input.ticket}: assignment ${input.id} was abandoned on resume to another slot.\nAbandoned delegations: ${delegations.map((row) => row.id).join(', ') || 'none'}\nAbandoned requests: ${requests.map((row) => row.id).join(', ') || 'none'}`,
    }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

    yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`, [slot.slotId, input.now, message.id]);
  }

  yield* change.query(`UPDATE message SET status = 'dropped' WHERE id IN (SELECT message_id FROM resume_notice WHERE assignment_id = ?)
    AND status IN ('unbound', 'bound')`, [input.id]);
  yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = ?, end_reason = 'abandoned' WHERE id = ?`, [input.now, input.id]);
  yield* change.recordHistory({ factoryId: input.factoryId, kind: "assignment.abandoned", subject: input.id,
    detail: { requests: requests.map((row) => row.id), delegations: delegations.map((row) => row.id) } });
});
