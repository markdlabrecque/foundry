/** Operator resolution of a message-budget decision, in the action's existing transaction. */
import { Effect } from "effect";
import type { Change } from "./store.js";
import { ticketRecord } from "./history-records.js";

export const restoreMessageAllowance = (change: Change, factory: string, number: number, budget: number, now: number, action: "resume" | "retry") =>
  Effect.gen(function* () {
    const approvals = yield* change.query<{ id: number }>(
      `UPDATE approval SET state = 'resolved', closed_at = ?
       WHERE factory_id = ? AND ticket_number = ? AND kind = 'limit_reached' AND state = 'open'
         AND transition_sequence IN (SELECT sequence FROM ticket_transition
           WHERE factory_id = ? AND ticket_number = ? AND reason = 'Message budget reached') RETURNING id`,
      [now, factory, number, factory, number],
    );

    if (approvals.length === 0) {return undefined;}

    yield* change.query(`UPDATE ticket SET message_ceiling = message_ceiling + ? WHERE factory_id = ? AND number = ?`, [budget, factory, number]);

    for (const approval of approvals) {
      yield* change.recordHistory({ factoryId: factory, kind: "approval.resolved", subject: String(approval.id),
        detail: { action, messageAllowance: budget }, records: [ticketRecord(number)] });
    }

    return `Message allowance increased by ${budget}`;
  });
