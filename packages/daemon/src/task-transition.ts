/** Authorized outcomes (PRD §8.2, §10.1). Scheduling reads committed state later. */
import { Clock, Effect, Schema } from "effect";
import type { AssignmentFactory } from "./assignments.js";
import { inspectCode } from "./code-observation.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { outcomeRoute } from "./outcome-route.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler, ToolCallContext } from "./submissions.js";
import type { Query } from "./store.js";
import { expectDefined } from "@foundry/protocol/errors";

const TransitionArgs = Schema.Struct({
  assignmentId: Schema.NonEmptyString,
  outcome: Schema.Literals(["done", "blocked", "rejected"]),
  reason: Schema.NonEmptyString,
  evidence: Schema.Array(Schema.NonEmptyString),
  gitCommit: Schema.optionalKey(Schema.NonEmptyString),
});

interface AssignedTicket {
  readonly ticket_number: number;
  readonly slot_id: string;
  readonly stage: string;
  readonly production_line: string;
  readonly rejections: number;
  readonly rejection_ceiling: number;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly expected_commit: string | null;
}

const assignedTicket = (query: Query, call: ToolCallContext, assignmentId: string) => query<AssignedTicket>(
  `SELECT a.ticket_number, a.slot_id, a.stage, t.production_line, t.rejections, t.rejection_ceiling, t.worktree_path, t.branch,
     COALESCE((SELECT git_commit FROM ticket_transition tr
       WHERE tr.factory_id = t.factory_id AND tr.ticket_number = t.number AND tr.git_commit IS NOT NULL
       ORDER BY tr.sequence DESC LIMIT 1), t.start_commit) AS expected_commit
   FROM assignment a JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
   WHERE a.id = ? AND a.factory_id = ? AND a.status = 'active'
     AND t.state = 'stage' AND t.status = 'assigned' AND t.stage = a.stage`,
  [assignmentId, call.factoryId],
);

interface CodeObservation {
  readonly assignment: AssignedTicket;
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly validate: () => Effect.Effect<void, ToolRefusal>;
}

export interface TaskTransitionOptions {
  readonly factories: ReadonlyArray<AssignmentFactory>;
  readonly configLoad?: (factoryId: string) => string | undefined;
}

/** Explicit assignment identity prevents a stale outcome from ending a later assignment on the
 * same slot. Factory and slot authority come only from the claimed channel, never arguments. */
const transitionHandler = (options: TaskTransitionOptions, observation?: CodeObservation): ToolHandler => (change, call) => Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(TransitionArgs)(call.args, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "task_transition needs assignmentId, outcome done/blocked/rejected, reason and evidence; no destination is accepted" })),
  );

  const rows = yield* assignedTicket(change.query, call, args.assignmentId);

  const assignment = rows[0];

  if (assignment === undefined || assignment.slot_id !== call.slotId) {
    return yield* new ToolRefusal({ code: "not_assignment_owner", detail: "only the active assignment's slot may report its outcome" });
  }

  const config = options.factories.find((f) => f.factoryId === call.factoryId)?.config;
  const stages = config?.production_lines[assignment.production_line]?.stages;
  const index = stages?.findIndex((s) => s.id === assignment.stage) ?? -1;
  const stage = index < 0 ? undefined : stages?.[index];

  if (stage === undefined) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "assignment stage is not configured" });
  }

  const room = config?.rooms[stage.station.split(".")[0] ?? ""];
  const station = room?.stations[stage.station.split(".")[1] ?? ""];

  if (args.outcome === "done" && (stages?.[index + 1] === undefined || stage.approval)) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "approval, completion and integration are not supported yet" });
  }

  if ((args.outcome === "done" && station?.isolation === "worktree") || assignment.worktree_path !== null) {
    if (args.outcome === "done" && station?.isolation === "worktree" && args.gitCommit === undefined) {
      return yield* new ToolRefusal({ code: "commit_required", detail: "done for a code stage requires the evaluated commit" });
    }

    if (observation === undefined || JSON.stringify(observation.assignment) !== JSON.stringify(assignment)) {
      return yield* new ToolRefusal({ code: "invalid_code_outcome", detail: "code assignment changed or its worktree could not be inspected; retry" });
    }

    yield* observation.validate();

    if (observation.branch !== `refs/heads/${assignment.branch}` || (args.gitCommit !== undefined && args.gitCommit !== observation.head)) {
      return yield* new ToolRefusal({ code: "invalid_code_outcome", detail: "the evaluated commit must be the ticket branch HEAD" });
    }

    if (!stage.writing && (observation.head !== assignment.expected_commit || observation.dirty)) {
      return yield* new ToolRefusal({ code: "non_writing_changes", detail: "non-writing stages must revert branch movement and tracked changes before reporting an outcome; reject to request changes" });
    }
  }

  if (args.outcome === "blocked" || (args.outcome === "rejected" && stage.on_rejection === undefined)) {
    const now = yield* Clock.currentTimeMillis;
    // A pause keeps the assignment and its open work, but releases its slot capacity.
    yield* change.query(`UPDATE assignment SET status = 'suspended' WHERE id = ?`, [args.assignmentId]);
    yield* change.query(`UPDATE ticket SET status = 'paused' WHERE factory_id = ? AND number = ?`,
      [call.factoryId, assignment.ticket_number]);

    const transitions = yield* change.query<{ sequence: number }>(
      `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
         from_state, from_stage, from_status, to_state, to_stage, to_status, outcome, reason, git_commit, evidence, config_load)
       VALUES (?, ?, ?, ?, 'stage', ?, 'assigned', 'stage', ?, 'paused', ?, ?, ?, ?, ?) RETURNING sequence`,
      [call.factoryId, assignment.ticket_number, now, call.slotId, assignment.stage, assignment.stage,
        args.outcome, args.reason, observation?.head ?? null, JSON.stringify(args.evidence), options.configLoad?.(call.factoryId) ?? null],
    );

    const transition = expectDefined(transitions[0], "the pause transition").sequence;

    const approvals = yield* change.query<{ id: number }>(
      `INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
       VALUES (?, ?, ?, ?, 'blocked', 'open', ?) RETURNING id`,
      [call.factoryId, assignment.ticket_number, args.assignmentId, transition, now],
    );

    const approvalId = expectDefined(approvals[0], "the blocked approval").id;
    const records = [ticketRecord(assignment.ticket_number), slotRecord(call.slotId)];
    yield* change.recordHistory({
      factoryId: call.factoryId, kind: "ticket.transitioned", subject: String(assignment.ticket_number),
      detail: { assignment: args.assignmentId, outcome: args.outcome, fromStage: assignment.stage,
        stage: assignment.stage, status: "paused", approvalId }, records,
    });
    yield* change.recordHistory({
      factoryId: call.factoryId, kind: "approval.requested", subject: String(approvalId),
      detail: { kind: "blocked", ticket: assignment.ticket_number, transition }, records,
    });

    if (observation !== undefined) {yield* observation.validate();}

    return { assignmentId: args.assignmentId, ticket: assignment.ticket_number, stage: assignment.stage, status: "paused", approvalId };
  }

  const target = outcomeRoute(stages ?? [], assignment.stage, args.outcome);

  if (target === undefined) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "no configured route; completion and integration are not supported yet" });
  }

  if ((args.outcome === "done" && stage.approval) || station === undefined || (stage.writing && station.isolation !== "worktree")) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "approval and invalid stage configurations are not supported" });
  }

  if (station.isolation === "worktree" && observation === undefined) {
    return yield* new ToolRefusal({ code: "invalid_code_outcome", detail: "code outcomes require an inspected ticket worktree" });
  }

  // Delegation acceptance can land independently of outcome handling. Never strand open work
  // under an ended root assignment, including descendants owned by other slots.
  const openDelegations = yield* change.query(
    `SELECT 1 FROM delegation WHERE factory_id = ? AND root_assignment = ? AND status = 'open' LIMIT 1`,
    [call.factoryId, args.assignmentId],
  );

  if (openDelegations.length > 0) {
    return yield* new ToolRefusal({ code: "open_delegations", detail: "outcome is refused while the assignment has open delegations" });
  }

  const limitReached = args.outcome === "rejected" && assignment.rejections + 1 >= assignment.rejection_ceiling;
  const status = limitReached ? "paused" : "queued";
  const now = yield* Clock.currentTimeMillis;
  yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ?`,
    [now, args.outcome, args.assignmentId]);
  yield* change.query(`UPDATE ticket SET stage = ?, status = ?, rejections = rejections + ? WHERE factory_id = ? AND number = ?`,
    [target, status, args.outcome === "rejected" ? 1 : 0, call.factoryId, assignment.ticket_number]);

  const transitions = yield* change.query<{ sequence: number }>(
    `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
       from_state, from_stage, from_status, to_state, to_stage, to_status, outcome, reason, git_commit, evidence, config_load)
     VALUES (?, ?, ?, ?, 'stage', ?, 'assigned', 'stage', ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
    [call.factoryId, assignment.ticket_number, now, call.slotId, assignment.stage, target, status, args.outcome,
      args.reason, observation?.head ?? null, JSON.stringify(args.evidence), options.configLoad?.(call.factoryId) ?? null],
  );

  let approvalId: number | undefined;

  if (limitReached) {
    const transition = expectDefined(transitions[0], "the rejection limit transition").sequence;

    const approvals = yield* change.query<{ id: number }>(
      `INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
       VALUES (?, ?, ?, ?, 'limit_reached', 'open', ?) RETURNING id`,
      [call.factoryId, assignment.ticket_number, args.assignmentId, transition, now],
    );

    approvalId = expectDefined(approvals[0], "the rejection limit approval").id;
  }

  yield* change.recordHistory({
    factoryId: call.factoryId, kind: "ticket.transitioned", subject: String(assignment.ticket_number),
    detail: { assignment: args.assignmentId, outcome: args.outcome, fromStage: assignment.stage, stage: target, status, approvalId },
    records: [ticketRecord(assignment.ticket_number), slotRecord(call.slotId)],
  });

  if (approvalId !== undefined) {
    yield* change.recordHistory({
      factoryId: call.factoryId, kind: "approval.requested", subject: String(approvalId),
      detail: { kind: "limit_reached", ticket: assignment.ticket_number,
        transition: expectDefined(transitions[0], "the rejection limit transition").sequence },
      records: [ticketRecord(assignment.ticket_number), slotRecord(call.slotId)],
    });
  }

  if (observation !== undefined) {yield* observation.validate();}

  const result = { assignmentId: args.assignmentId, ticket: assignment.ticket_number, stage: target, status };

  return approvalId === undefined ? result : { ...result, approvalId };
});

/** Git inspection is read-only and outside the submission transaction. No failed inspection can
 * end an assignment; replay/freeze checks still run before a prepared refusal is returned. */
export const taskTransitionHandler = (options: TaskTransitionOptions): ToolHandler => Object.assign(
  transitionHandler(options),
  { prepare: (query: Query, call: ToolCallContext) => Effect.gen(function* () {
    const args = yield* Schema.decodeUnknownEffect(TransitionArgs)(call.args, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "invalid task_transition arguments" })),
    );

    const assignment = (yield* assignedTicket(query, call, args.assignmentId))[0];

    if (assignment === undefined || assignment.slot_id !== call.slotId || assignment.worktree_path === null) {
      return transitionHandler(options);
    }

    if (assignment.branch === null) {
      return yield* new ToolRefusal({ code: "invalid_code_outcome", detail: "ticket branch identity is missing" });
    }

    const observation = yield* inspectCode(assignment.worktree_path, assignment.branch);

    return transitionHandler(options, { assignment, ...observation });
  }) },
);
