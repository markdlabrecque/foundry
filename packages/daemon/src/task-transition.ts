/** Authorized done outcomes (PRD §8.2, §10.1). Scheduling reads the committed queue later. */
import { Clock, Effect, Schema } from "effect";
import type { AssignmentFactory } from "./assignments.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler } from "./submissions.js";

const TransitionArgs = Schema.Struct({
  assignmentId: Schema.NonEmptyString,
  outcome: Schema.Literal("done"),
  reason: Schema.NonEmptyString,
  evidence: Schema.Array(Schema.NonEmptyString),
  gitCommit: Schema.optionalKey(Schema.NonEmptyString),
});

interface AssignedTicket {
  readonly ticket_number: number;
  readonly slot_id: string;
  readonly stage: string;
  readonly production_line: string;
}

export interface TaskTransitionOptions {
  readonly factories: ReadonlyArray<AssignmentFactory>;
  readonly configLoad?: (factoryId: string) => string | undefined;
}

/** Explicit assignment identity prevents a stale outcome from ending a later assignment on the
 * same slot. Factory and slot authority come only from the claimed channel, never arguments. */
export const taskTransitionHandler = (options: TaskTransitionOptions): ToolHandler => (change, call) => Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(TransitionArgs)(call.args, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "task_transition needs assignmentId, outcome done, reason and evidence; no destination is accepted" })),
  );

  const rows = yield* change.query<AssignedTicket>(
    `SELECT a.ticket_number, a.slot_id, a.stage, t.production_line FROM assignment a
     JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
     WHERE a.id = ? AND a.factory_id = ? AND a.status = 'active'
       AND t.state = 'stage' AND t.status = 'assigned' AND t.stage = a.stage`,
    [args.assignmentId, call.factoryId],
  );

  const assignment = rows[0];

  if (assignment === undefined || assignment.slot_id !== call.slotId) {
    return yield* new ToolRefusal({ code: "not_assignment_owner", detail: "only the active assignment's slot may report its outcome" });
  }

  const config = options.factories.find((f) => f.factoryId === call.factoryId)?.config;
  const stages = config?.production_lines[assignment.production_line]?.stages;
  const index = stages?.findIndex((s) => s.id === assignment.stage) ?? -1;
  const stage = index < 0 ? undefined : stages?.[index];
  const next = index < 0 ? undefined : stages?.[index + 1];

  if (stage === undefined || next === undefined) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "no configured next stage; completion and integration are not supported yet" });
  }

  // These workflows have their own tickets. Fail closed rather than bypass an approval or
  // pretend a worker-supplied commit proves the code-stage branch/dirty-tree guards.
  const room = config?.rooms[stage.station.split(".")[0] ?? ""];
  const station = room?.stations[stage.station.split(".")[1] ?? ""];

  if (stage.approval || stage.writing || station === undefined || station.isolation === "worktree") {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "approval and code-stage outcome checks are not supported yet" });
  }

  const now = yield* Clock.currentTimeMillis;
  yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = ?, end_reason = 'done' WHERE id = ?`,
    [now, args.assignmentId]);
  yield* change.query(`UPDATE ticket SET stage = ?, status = 'queued' WHERE factory_id = ? AND number = ?`,
    [next.id, call.factoryId, assignment.ticket_number]);
  yield* change.query(
    `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
       from_state, from_stage, from_status, to_state, to_stage, to_status, outcome, reason, git_commit, evidence, config_load)
     VALUES (?, ?, ?, ?, 'stage', ?, 'assigned', 'stage', ?, 'queued', 'done', ?, ?, ?, ?)`,
    [call.factoryId, assignment.ticket_number, now, call.slotId, assignment.stage, next.id,
      args.reason, args.gitCommit ?? null, JSON.stringify(args.evidence), options.configLoad?.(call.factoryId) ?? null],
  );
  yield* change.recordHistory({
    factoryId: call.factoryId, kind: "ticket.transitioned", subject: String(assignment.ticket_number),
    detail: { assignment: args.assignmentId, outcome: "done", fromStage: assignment.stage, stage: next.id, status: "queued" },
    records: [ticketRecord(assignment.ticket_number), slotRecord(call.slotId)],
  });

  return { assignmentId: args.assignmentId, ticket: assignment.ticket_number, stage: next.id, status: "queued" };
});
