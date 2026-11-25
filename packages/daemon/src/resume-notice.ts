/** Transaction-local resume notices (PRD §10.2). Recovery callers share this composer. */
import { Clock, Effect } from "effect";
import { acceptMessage } from "./agent-message.js";
import type { Change } from "./store.js";

export interface ResumeNotice {
  readonly assignmentId: string;
  readonly factoryId: string;
  readonly ticket: number;
  readonly stage: string;
  readonly slotId: string;
  readonly recipient: string;
  readonly message?: string | null;
}

/** Refresh an outstanding notice rather than creating a second turn. Its exact-slot binding
 * prevents a later router pass from sending interrupted work to another worker. */
export const composeResumeNotice = (change: Change, input: ResumeNotice) => Effect.gen(function* () {
  const [active] = yield* change.query<{ id: string }>(
    `SELECT id FROM assignment WHERE id = ? AND factory_id = ? AND status = 'active'`,
    [input.assignmentId, input.factoryId],
  );

  if (active === undefined) {return null;}

  const requests = yield* change.query<{ id: string }>(
    `SELECT id FROM agent_request WHERE factory_id = ? AND ticket_number = ? AND requester_slot = ? AND status = 'open' ORDER BY id`,
    [input.factoryId, input.ticket, input.slotId],
  );

  const delegations = yield* change.query<{ id: string }>(
    `SELECT id FROM delegation WHERE root_assignment = ? AND status = 'open' ORDER BY id`, [input.assignmentId],
  );

  const [outcome] = yield* change.query<{ outcome: string | null }>(
    `SELECT t.outcome FROM approval a JOIN ticket_transition t ON t.sequence = a.transition_sequence
     WHERE a.assignment_id = ? ORDER BY t.sequence DESC LIMIT 1`, [input.assignmentId],
  );

  const body = `Ticket ${input.ticket}\nStage: ${input.stage}\nAssignment: ${input.assignmentId}\nThe worker was interrupted or the daemon was unavailable. The last tool call may or may not have completed. Inspect the worktree and ticket directory before continuing; do not replay tool calls blindly.\nReported outcome: ${outcome?.outcome ?? 'none'}\nOpen requests: ${requests.map((row) => row.id).join(', ') || 'none'}\nOpen delegations: ${delegations.map((row) => row.id).join(', ') || 'none'}${input.message === undefined || input.message === null ? '' : `\nOperator message: ${input.message}`}`;

  const [existing] = yield* change.query<{ id: string }>(
    `SELECT m.id FROM resume_notice n JOIN message m ON m.id = n.message_id WHERE n.assignment_id = ?
     AND m.status IN ('unbound', 'bound', 'sent', 'indeterminate') ORDER BY m.sequence DESC LIMIT 1`, [input.assignmentId],
  );

  if (existing !== undefined) {
    yield* change.query(`UPDATE message SET body = ? WHERE id = ?`, [body, existing.id]);
    yield* change.recordHistory({ factoryId: input.factoryId, kind: "message.resume_refreshed", subject: existing.id,
      detail: { assignment: input.assignmentId } });

    return existing.id;
  }

  const message = yield* acceptMessage(change, {
    factoryId: input.factoryId, senderKind: "daemon", senderSlot: null, recipient: input.recipient,
    kind: "resume_notice", delivery: "after_turn", correlation: { ticket: input.ticket }, body,
  }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

  const now = yield* Clock.currentTimeMillis;
  yield* change.query(`INSERT INTO resume_notice (message_id, assignment_id) VALUES (?, ?)`, [message.id, input.assignmentId]);
  yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ? WHERE id = ?`, [input.slotId, now, message.id]);

  return message.id;
});
