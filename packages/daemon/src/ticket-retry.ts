/** Retry abandons durable obligations atomically; the ordinary scheduler creates full context later. */
import { Clock, Effect } from "effect";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { SlotsError } from "./slots-error.js";
import type { SlotInterrupter } from "./slots-error.js";
import type { Change } from "./store.js";
import { TicketError } from "./tickets.js";
import type { TicketServiceOptions } from "./tickets.js";

export const interruptTicketSlot = (interrupter: SlotInterrupter | undefined, factory: string, slot: string) => {
  if (interrupter === undefined) {
    return Effect.fail(new TicketError({ code: "unavailable", message: "Worker interrupts are unavailable" }));
  }

  return Effect.tryPromise({
    try: () => interrupter.interrupt(slot, factory),
    catch: (error) => new TicketError({
      code: error instanceof SlotsError && (error.code === "no_live_launch" || error.code === "channel_unavailable" || error.code === "interrupt_unacknowledged") ? error.code : "internal",
      message: error instanceof Error ? error.message : String(error),
    }),
  });
};

interface RetryAssignment {
  id: string;
  slot_id: string;
  stage: string;
  status: string;
  assignment_status: string;
}

/** Exact-slot notices cannot drift to an unrelated slot after a retry. */
const notify = (change: Change, factory: string, ticket: number, slot: string, body: string, now: number) => Effect.gen(function* () {
  const message = yield* acceptMessage(change, {
    factoryId: factory, senderKind: "daemon", senderSlot: null, recipient: slot,
    body, delivery: "after_turn", kind: "ordinary", correlation: { ticket },
  }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

  yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`, [slot, now, message.id]);
  yield* change.recordHistory({ factoryId: factory, kind: "message.bound", subject: message.id,
    detail: { sequence: message.sequence, slotId: slot }, records: [ticketRecord(ticket), slotRecord(slot)] });
});

export const retryTicket = (options: TicketServiceOptions, factory: string, number: number) => Effect.gen(function* () {
  const { store } = options;

  const [assignment] = yield* store.read<RetryAssignment>(
    `SELECT a.id, a.slot_id, a.stage, a.status AS assignment_status, t.status FROM assignment a
     JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
     WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status IN ('assigned', 'paused')
       AND a.status != 'ended' AND a.stage = t.stage`, [factory, number],
  );

  if (assignment === undefined) {
    return yield* new TicketError({ code: "invalid_state", message: "Retry requires a paused or assigned ticket with an assignment to abandon" });
  }

  if (assignment.status === "assigned") {yield* interruptTicketSlot(options.interrupter, factory, assignment.slot_id);}

  yield* store.change((change) => Effect.gen(function* () {
    const [current] = yield* change.query(
      `SELECT 1 FROM assignment a JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
       WHERE a.id = ? AND a.factory_id = ? AND a.ticket_number = ? AND a.status = ?
         AND t.state = 'stage' AND t.status = ? AND t.stage = ?`,
      [assignment.id, factory, number, assignment.assignment_status, assignment.status, assignment.stage],
    );

    if (current === undefined) {
      return yield* new TicketError({ code: "invalid_state", message: "The assignment changed while retry was in progress" });
    }

    const now = yield* Clock.currentTimeMillis;
    const records = [ticketRecord(number), slotRecord(assignment.slot_id)];

    const requests = yield* change.query<{ id: string; notice_id: string; requester_slot: string; recipient_slot: string | null }>(
      `UPDATE agent_request SET status = 'abandoned' WHERE factory_id = ? AND ticket_number = ? AND status = 'open'
       RETURNING id, notice_id, requester_slot, recipient_slot`, [factory, number],
    );

    const delegations = yield* change.query<{ id: string; notice_id: string; delegating_slot: string; recipient_slot: string | null }>(
      `UPDATE delegation SET status = 'abandoned' WHERE factory_id = ? AND root_assignment = ? AND status = 'open'
       RETURNING id, notice_id, delegating_slot, recipient_slot`, [factory, assignment.id],
    );

    for (const obligation of [...requests, ...delegations]) {
      // Suppress only copies proven unattempted; attempted copies keep immutable receipt evidence.
      yield* change.query(`UPDATE message SET status = 'dropped' WHERE id = ? AND status IN ('unbound', 'bound')
        AND NOT EXISTS (SELECT 1 FROM message_attempt WHERE message_id = message.id)`, [obligation.notice_id]);
      const kind = "requester_slot" in obligation ? "request" : "delegation";
      const sender = "requester_slot" in obligation ? obligation.requester_slot : obligation.delegating_slot;
      yield* change.recordHistory({ factoryId: factory, kind: `${kind}.abandoned`, subject: obligation.id,
        detail: { assignment: assignment.id, reason: "ticket retry" }, records });

      for (const slot of new Set([sender, obligation.recipient_slot])) {
        if (slot !== null && slot !== assignment.slot_id) {
          yield* notify(change, factory, number, slot,
            `Ticket ${number} retried: ${kind} ${obligation.id} abandoned (assignment ${assignment.id}).`, now);
        }
      }
    }

    const approvals = yield* change.query<{ id: number }>(
      `UPDATE approval SET state = 'resolved', closed_at = ? WHERE factory_id = ? AND ticket_number = ?
       AND kind = 'blocked' AND state = 'open' RETURNING id`, [now, factory, number],
    );

    for (const approval of approvals) {
      yield* change.recordHistory({ factoryId: factory, kind: "approval.resolved", subject: String(approval.id),
        detail: { action: "retry", assignment: assignment.id }, records });
    }

    yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = ?, end_reason = 'abandoned' WHERE id = ?`, [now, assignment.id]);
    // Any old, unattempted context must not precede the fresh assignment as actionable work.
    yield* change.query(`UPDATE message SET status = 'dropped' WHERE id IN (
        SELECT context_message FROM assignment WHERE id = ?
        UNION SELECT message_id FROM repository_context WHERE assignment_id = ?)
      AND status IN ('unbound', 'bound') AND NOT EXISTS (SELECT 1 FROM message_attempt WHERE message_id = message.id)`, [assignment.id, assignment.id]);
    yield* change.query(`UPDATE ticket SET status = 'queued' WHERE factory_id = ? AND number = ?`, [factory, number]);
    yield* change.query(
      `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
         from_state, from_stage, from_status, to_state, to_stage, to_status, reason, config_load)
       VALUES (?, ?, ?, 'operator', 'stage', ?, ?, 'stage', ?, 'queued', 'ticket retry', ?)`,
      [factory, number, now, assignment.stage, assignment.status, assignment.stage, options.configLoad?.(factory) ?? null],
    );
    yield* change.recordHistory({ factoryId: factory, kind: "ticket.retried", subject: String(number),
      detail: { assignment: assignment.id, slotId: assignment.slot_id }, records });
  }));
});
