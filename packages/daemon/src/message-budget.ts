/** Ticket message allowance, charged only by shared agent-message acceptance (PRD §6.4). */
import { Clock, Effect } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import type { MessageAcceptanceGuards } from "./agent-message.js";
import { suspendAssignment } from "./assignments.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";

export const messageBudget = (configLoad?: (factoryId: string) => string | undefined): NonNullable<MessageAcceptanceGuards["budget"]> =>
  (change, message) => Effect.gen(function* () {
    if (message.ticket === null) {return;}

    const [ticket] = yield* change.query<{ messages_spent: number; message_ceiling: number; stage: string; status: string; assignment_id: string | null; slot_id: string | null }>(
      `SELECT t.messages_spent, t.message_ceiling, t.stage, t.status, a.id AS assignment_id, a.slot_id
       FROM ticket t LEFT JOIN assignment a ON a.id = (
         SELECT id FROM assignment WHERE factory_id = t.factory_id AND ticket_number = t.number
         ORDER BY created_at DESC, rowid DESC LIMIT 1)
       WHERE t.factory_id = ? AND t.number = ?`,
      [message.factoryId, message.ticket],
    );

    if (ticket === undefined || ticket.messages_spent >= ticket.message_ceiling) {
      return yield* new ToolRefusal({ code: "message_budget_reached", detail: "ticket message allowance is exhausted or unavailable" });
    }

    yield* change.query(`UPDATE ticket SET messages_spent = messages_spent + 1 WHERE factory_id = ? AND number = ?`,
      [message.factoryId, message.ticket]);

    if (ticket.messages_spent + 1 < ticket.message_ceiling) {return;}

    if (ticket.assignment_id === null || ticket.slot_id === null) {
      return yield* new ToolRefusal({ code: "message_budget_reached", detail: "ticket has no assignment for the limit decision" });
    }

    const now = yield* Clock.currentTimeMillis;
    yield* suspendAssignment(change, ticket.assignment_id);
    yield* change.query(`UPDATE ticket SET status = 'paused' WHERE factory_id = ? AND number = ?`, [message.factoryId, message.ticket]);

    const transitions = yield* change.query<{ sequence: number }>(
      `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
         from_state, from_stage, from_status, to_state, to_stage, to_status, reason, config_load)
       VALUES (?, ?, ?, 'daemon', 'stage', ?, ?, 'stage', ?, 'paused', 'Message budget reached', ?) RETURNING sequence`,
      [message.factoryId, message.ticket, now, ticket.stage, ticket.status, ticket.stage, configLoad?.(message.factoryId) ?? null],
    );

    const transition = expectDefined(transitions[0], "the message limit transition").sequence;

    const approvals = yield* change.query<{ id: number }>(
      `INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
       VALUES (?, ?, ?, ?, 'limit_reached', 'open', ?) RETURNING id`,
      [message.factoryId, message.ticket, ticket.assignment_id, transition, now],
    );

    const approvalId = expectDefined(approvals[0], "the message limit approval").id;
    const records = [ticketRecord(message.ticket), slotRecord(ticket.slot_id)];
    yield* change.recordHistory({ factoryId: message.factoryId, kind: "ticket.paused", subject: String(message.ticket),
      detail: { assignment: ticket.assignment_id, reason: "message_budget", approvalId, message: message.id }, records });
    yield* change.recordHistory({ factoryId: message.factoryId, kind: "approval.requested", subject: String(approvalId),
      detail: { kind: "limit_reached", ticket: message.ticket, transition }, records });
  });
