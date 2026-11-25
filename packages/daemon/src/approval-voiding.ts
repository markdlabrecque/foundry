/** Commit-bound review/QA/gate validity (PRD §8.2). Git never runs under the store lock. */
import { Clock, Data, Effect } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import type { AssignmentFactory } from "./assignments.js";
import { inspectCode } from "./code-observation.js";
import { ticketRecord } from "./history-records.js";
import type { Query, Store } from "./store.js";

interface TicketHead {
  readonly factory_id: string;
  readonly number: number;
  readonly production_line: string;
  readonly stage: string;
  readonly status: string;
  readonly worktree_path: string;
  readonly branch: string;
}

interface Evaluation {
  readonly sequence: number;
  readonly from_stage: string;
  readonly git_commit: string;
}

export interface ApprovalVoidingOptions {
  readonly store: Store;
  readonly factories: ReadonlyArray<AssignmentFactory>;
  readonly configLoad?: (factory: string) => string | undefined;
  readonly inScope?: (factory: string) => boolean;
  /** Must settle an active non-writing worker before releasing its assignment. */
  readonly interrupt?: (slot: string, factory: string) => Promise<void>;
}

class Unchanged extends Data.TaggedError("ApprovalHeadUnchanged") {} 

const evaluations = (query: Query, ticket: TicketHead) => query<Evaluation>(
  `SELECT tr.sequence, tr.from_stage, tr.git_commit FROM ticket_transition tr
   WHERE tr.factory_id = ? AND tr.ticket_number = ? AND tr.outcome = 'done' AND tr.git_commit IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ticket_transition v, json_each(v.voided_transitions) j
       WHERE v.factory_id = tr.factory_id AND v.ticket_number = tr.ticket_number AND j.value = tr.sequence)
     AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.transition_sequence = tr.sequence AND a.decision = 'rejected')
   ORDER BY tr.sequence`, [ticket.factory_id, ticket.number],
);

/** One transition voids every stale evaluation together. Writing work may legitimately move HEAD;
 * let its outcome end the assignment first, then invalidate before the next assignment starts. */
export const voidStaleApprovals = (options: ApprovalVoidingOptions, only?: { factory: string; ticket: number }) => Effect.gen(function* () {
  const tickets = yield* options.store.read<TicketHead>(
    `SELECT factory_id, number, production_line, stage, status, worktree_path, branch FROM ticket
     WHERE state = 'stage' AND worktree_path IS NOT NULL AND branch IS NOT NULL
       ${only === undefined ? "" : "AND factory_id = ? AND number = ?"}`,
    only === undefined ? [] : [only.factory, only.ticket],
  );

  let count = 0;

  for (const ticket of tickets) {
    if (options.inScope?.(ticket.factory_id) === false) {continue;}

    const stages = options.factories.find((f) => f.factoryId === ticket.factory_id)?.config.production_lines[ticket.production_line]?.stages;

    if (stages === undefined || (ticket.status === "assigned" && stages.find((s) => s.id === ticket.stage)?.writing)) {continue;}

    const checkedStages = new Set(stages.filter((s) => !s.writing).map((s) => s.id));
    const before = yield* evaluations(options.store.read, ticket);

    if (!before.some((row) => checkedStages.has(row.from_stage))) {continue;}

    const observation = yield* inspectCode(ticket.worktree_path, ticket.branch);

    if (observation.branch !== `refs/heads/${ticket.branch}`) {continue;}

    const stale = before.filter((row) => checkedStages.has(row.from_stage) && row.git_commit !== observation.head);

    if (stale.length === 0) {continue;}

    const target = stages.find((stage) => stale.some((row) => row.from_stage === stage.id));

    if (target === undefined) {continue;}

    const assignments = yield* options.store.read<{ id: string; slot_id: string; status: string }>(
      `SELECT id, slot_id, status FROM assignment WHERE factory_id = ? AND ticket_number = ? AND status != 'ended'`,
      [ticket.factory_id, ticket.number],
    );

    const active = assignments.find((a) => a.status === "active");

    if (active !== undefined) {
      const interrupt = options.interrupt;

      if (interrupt === undefined) {continue;}

      yield* Effect.tryPromise({ try: () => interrupt(active.slot_id, ticket.factory_id), catch: (cause) => cause });
    }

    const changed = yield* options.store.change((change) => Effect.gen(function* () {
      yield* observation.validate();

      const [current] = yield* change.query<TicketHead>(`SELECT factory_id, number, production_line, stage, status, worktree_path, branch
        FROM ticket WHERE factory_id = ? AND number = ? AND state = 'stage'`, [ticket.factory_id, ticket.number]);

      const currentAssignments = yield* change.query<{ id: string; slot_id: string; status: string }>(
        `SELECT id, slot_id, status FROM assignment WHERE factory_id = ? AND ticket_number = ? AND status != 'ended'`, [ticket.factory_id, ticket.number]);

      if (JSON.stringify(current) !== JSON.stringify(ticket) || JSON.stringify(currentAssignments) !== JSON.stringify(assignments) ||
        JSON.stringify(yield* evaluations(change.query, ticket)) !== JSON.stringify(before) || options.inScope?.(ticket.factory_id) === false) {
        return yield* new Unchanged();
      }

      const now = yield* Clock.currentTimeMillis;
      const voided = stale.map((row) => row.sequence);

      const [transition] = yield* change.query<{ sequence: number }>(
        `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage, from_status,
           to_state, to_stage, to_status, outcome, reason, git_commit, config_load, voided_transitions)
         VALUES (?, ?, ?, 'daemon', 'stage', ?, ?, 'stage', ?, 'queued', 'voided', ?, ?, ?, ?) RETURNING sequence`,
        [ticket.factory_id, ticket.number, now, ticket.stage, ticket.status, target.id,
          `Branch head changed; voided transitions ${voided.join(", ")}`, observation.head,
          options.configLoad?.(ticket.factory_id) ?? null, JSON.stringify(voided)],
      );

      const sequence = expectDefined(transition, "voiding transition").sequence;
      yield* change.query(`UPDATE ticket SET stage = ?, status = 'queued' WHERE factory_id = ? AND number = ?`, [target.id, ticket.factory_id, ticket.number]);
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = ?, end_reason = 'voided'
        WHERE factory_id = ? AND ticket_number = ? AND status != 'ended'`, [now, ticket.factory_id, ticket.number]);
      yield* change.query(`UPDATE delegation SET status = 'cancelled' WHERE factory_id = ? AND status = 'open'
        AND root_assignment IN (SELECT id FROM assignment WHERE factory_id = ? AND ticket_number = ?)`, [ticket.factory_id, ticket.factory_id, ticket.number]);
      yield* change.query(`UPDATE agent_request SET status = 'cancelled' WHERE factory_id = ? AND ticket_number = ? AND status = 'open'`, [ticket.factory_id, ticket.number]);
      yield* change.query(`UPDATE message SET status = 'dropped' WHERE factory_id = ? AND ticket_number = ?
        AND status IN ('unbound', 'bound') AND NOT EXISTS (SELECT 1 FROM message_attempt WHERE message_id = message.id)`, [ticket.factory_id, ticket.number]);
      // Resolved operator decisions remain immutable evidence of what was decided. The voiding
      // transition names both those decisions and their worker evaluations; it grants no approval.
      yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = ?,
        resolution_transition = CASE WHEN kind = 'stage_gate' THEN ? ELSE resolution_transition END
        WHERE factory_id = ? AND ticket_number = ? AND state = 'open'`, [now, sequence, ticket.factory_id, ticket.number]);
      yield* change.query(`DELETE FROM integration_intent WHERE factory_id = ? AND ticket_number = ?`, [ticket.factory_id, ticket.number]);
      yield* change.recordHistory({ factoryId: ticket.factory_id, kind: "ticket.transitioned", subject: String(ticket.number),
        detail: { actor: "daemon", outcome: "voided", fromStage: ticket.stage, stage: target.id, status: "queued",
          commit: observation.head, voidedTransitions: voided, transition: sequence }, records: [ticketRecord(ticket.number)] });
      yield* observation.validate();

      return true;
    })).pipe(Effect.catchTag("ApprovalHeadUnchanged", () => Effect.succeed(false)));

    if (changed) {count++;}
  }

  return count;
});

/** Store commits catch worker outcomes; periodic sweeps also detect external Git changes. */
export const watchApprovalHeads = (options: ApprovalVoidingOptions, onError: (cause: unknown) => void) => {
  let running: Promise<void> | undefined;
  let stopped = false;
  let dirty = false;

  const wake = () => {
    dirty = true;

    if (running !== undefined || stopped) {return;}

    running = Promise.resolve().then(async () => {
      while (dirty && !stopped) {
        dirty = false;
        await Effect.runPromise(voidStaleApprovals(options)).catch(onError);
      }
    }).finally(() => { running = undefined;

 if (dirty && !stopped) {wake();} });
  };

  const unsubscribe = options.store.onCommit(wake);
  const timer = setInterval(wake, 1000);
  timer.unref();
  wake();

  return async () => { stopped = true; unsubscribe(); clearInterval(timer); await running; };
};
