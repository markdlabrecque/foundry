/** Authorized done outcomes (PRD §8.2, §10.1). Scheduling reads the committed queue later. */
import { Clock, Effect, Schema } from "effect";
import type { AssignmentFactory } from "./assignments.js";
import { runCloneGit } from "./factory-clone.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler, ToolCallContext } from "./submissions.js";
import type { Query } from "./store.js";

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
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly expected_commit: string | null;
}

const assignedTicket = (query: Query, call: ToolCallContext, assignmentId: string) => query<AssignedTicket>(
  `SELECT a.ticket_number, a.slot_id, a.stage, t.production_line, t.worktree_path, t.branch,
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
}

export interface TaskTransitionOptions {
  readonly factories: ReadonlyArray<AssignmentFactory>;
  readonly configLoad?: (factoryId: string) => string | undefined;
}

/** Explicit assignment identity prevents a stale outcome from ending a later assignment on the
 * same slot. Factory and slot authority come only from the claimed channel, never arguments. */
const transitionHandler = (options: TaskTransitionOptions, observation?: CodeObservation): ToolHandler => (change, call) => Effect.gen(function* () {
  const args = yield* Schema.decodeUnknownEffect(TransitionArgs)(call.args, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "task_transition needs assignmentId, outcome done, reason and evidence; no destination is accepted" })),
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
  const next = index < 0 ? undefined : stages?.[index + 1];

  if (stage === undefined || next === undefined) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "no configured next stage; completion and integration are not supported yet" });
  }

  // Approval and final integration remain separate workflows.
  const room = config?.rooms[stage.station.split(".")[0] ?? ""];
  const station = room?.stations[stage.station.split(".")[1] ?? ""];

  if (stage.approval || station === undefined || (stage.writing && station.isolation !== "worktree")) {
    return yield* new ToolRefusal({ code: "unsupported_transition", detail: "approval and invalid stage configurations are not supported" });
  }

  if (station.isolation === "worktree") {
    if (args.gitCommit === undefined) {
      return yield* new ToolRefusal({ code: "commit_required", detail: "done for a code stage requires the evaluated commit" });
    }

    if (observation === undefined || JSON.stringify(observation.assignment) !== JSON.stringify(assignment)) {
      return yield* new ToolRefusal({ code: "invalid_code_outcome", detail: "code assignment changed or its worktree could not be inspected; retry" });
    }

    if (observation.branch !== `refs/heads/${assignment.branch}` || args.gitCommit !== observation.head) {
      return yield* new ToolRefusal({ code: "invalid_code_outcome", detail: "the evaluated commit must be the ticket branch HEAD" });
    }

    if (!stage.writing && (observation.head !== assignment.expected_commit || observation.dirty)) {
      return yield* new ToolRefusal({ code: "non_writing_changes", detail: "non-writing stages must revert branch movement and tracked changes before reporting an outcome; reject to request changes" });
    }
  }

  // Delegation acceptance can land independently of outcome handling. Never strand open work
  // under an ended root assignment, including descendants owned by other slots.
  const openDelegations = yield* change.query(
    `SELECT 1 FROM delegation WHERE factory_id = ? AND root_assignment = ? AND status = 'open' LIMIT 1`,
    [call.factoryId, args.assignmentId],
  );

  if (openDelegations.length > 0) {
    return yield* new ToolRefusal({ code: "open_delegations", detail: "done is refused while the assignment has open delegations" });
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

    const path = assignment.worktree_path;

    const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
      try: () => runCloneGit(["--no-optional-locks", ...args], process.env, path),
      catch: () => new ToolRefusal({ code: "invalid_code_outcome", detail: "cannot inspect the ticket worktree; restore it before reporting an outcome" }),
    });

    const head = yield* git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = yield* git(["symbolic-ref", "HEAD"]);
    const dirty = (yield* git(["status", "--porcelain=v1", "--untracked-files=no"])) !== "";

    return transitionHandler(options, { assignment, head, branch, dirty });
  }) },
);
