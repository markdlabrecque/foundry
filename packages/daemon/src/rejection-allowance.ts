/** A routed rejection ends its assignment; operator consent queues a fresh one. */
import { Clock, Effect } from "effect";
import type { Change } from "./store.js";
import { ticketRecord } from "./history-records.js";
import { TicketError } from "./tickets.js";
import type { TicketServiceOptions } from "./tickets.js";

/** Returns false for other pauses, leaving their existing operator workflows untouched. */
export const restoreRejectionAllowance = (change: Change, options: TicketServiceOptions,
  factory: string, number: number, action: "resume" | "retry") => Effect.gen(function* () {
  const [row] = yield* change.query<{ id: number; stage: string; production_line: string; rejection_ceiling: number }>(
    `SELECT p.id, t.stage, t.production_line, t.rejection_ceiling FROM ticket t
     JOIN approval p ON p.factory_id = t.factory_id AND p.ticket_number = t.number
     JOIN ticket_transition tr ON tr.sequence = p.transition_sequence
     WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status = 'paused'
       AND p.kind = 'limit_reached' AND p.state = 'open' AND tr.outcome = 'rejected'
       AND t.rejections >= t.rejection_ceiling`, [factory, number],
  );

  if (row === undefined) {return false;}

  const limit = options.factories().find((f) => f.name === factory)?.lines[row.production_line]?.rejectionLimit;

  if (limit === undefined) {
    return yield* new TicketError({ code: "unknown_line", message: "The ticket's production line is not loaded" });
  }

  const now = yield* Clock.currentTimeMillis;
  const ceiling = row.rejection_ceiling + limit;
  const reason = `ticket ${action}; rejection ceiling raised from ${row.rejection_ceiling} to ${ceiling} (+${limit})`;
  yield* change.query(`UPDATE ticket SET status = 'queued', rejection_ceiling = ? WHERE factory_id = ? AND number = ?`,
    [ceiling, factory, number]);
  yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = ? WHERE id = ?`, [now, row.id]);
  yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
    from_state, from_stage, from_status, to_state, to_stage, to_status, reason, config_load)
    VALUES (?, ?, ?, 'operator', 'stage', ?, 'paused', 'stage', ?, 'queued', ?, ?)`,
  [factory, number, now, row.stage, row.stage, reason, options.configLoad?.(factory) ?? null]);
  const records = [ticketRecord(number)];
  yield* change.recordHistory({ factoryId: factory, kind: "approval.resolved", subject: String(row.id),
    detail: { action, rejectionCeiling: ceiling, allowance: limit }, records });
  yield* change.recordHistory({ factoryId: factory, kind: `ticket.${action === "resume" ? "resumed" : "retried"}`, subject: String(number),
    detail: { rejectionCeiling: ceiling, allowance: limit }, records });

  return true;
});
