/** Exact-SHA integration for the unchanged-default path (PRD §9.3–4).
 * Moved-default conflicts are rejected from a disposable worktree. Clean moved-default
 * verification and completed-ticket worktree cleanup have separate owners.
 * No fetch, push, ticket-branch rewrite, or cleanup runs here.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ticketApprovalLock } from "./approval-coordination.js";
import { Clock, Data, Effect, Schema } from "effect";
import { expectDefined, messageOf } from "@foundry/protocol/errors";
import { runCloneGit } from "./factory-clone.js";
import type { SyncTarget } from "./factory-sync.js";
import { ticketRecord } from "./history-records.js";
import { outcomeRoute } from "./outcome-route.js";
import { extendOperationIntent, recordOperationResult } from "./operations.js";
import type { Operation, OperationDetail, OperationOutcome } from "./operations.js";
import type { Store, StoreError } from "./store.js";

class IntegrationRefused extends Data.TaggedError("IntegrationRefused")<{ readonly reason: string }> {}

interface IntegrationTicket {
  readonly state: string;
  readonly production_line: string;
  readonly rejections: number;
  readonly rejection_ceiling: number;
  readonly stage: string;
  readonly status: string;
  readonly start_commit: string | null;
  readonly approved_commit: string;
  readonly branch: string | null;
}

const decodeIntent = Schema.decodeUnknownSync(Schema.Struct({ approvalId: Schema.Number, approvedCommit: Schema.String }));

const integrationGit = (clonePath: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => Effect.tryPromise({
  try: () => runCloneGit(["-c", "core.hooksPath=/dev/null", ...args], env, clonePath),
  catch: (cause) => new IntegrationRefused({ reason: messageOf(cause) }),
});

/** Already admitted by the shared integration/sync queue. Git always runs outside transactions. */
export const integrateApprovedCommit = (
  store: Store, operation: Operation, target: SyncTarget, env: NodeJS.ProcessEnv,
): Effect.Effect<void, StoreError> => ticketApprovalLock(store, operation.factoryId, operation.ticket ?? 0).withPermit(Effect.scoped(Effect.gen(function* () {
  const intent = decodeIntent(operation.intent);
  const clonePath = target.clonePath;
  const git = (args: ReadonlyArray<string>) => integrationGit(clonePath, env, args);

  const rows = yield* store.read<IntegrationTicket>(
    `SELECT t.state, t.production_line, t.rejections, t.rejection_ceiling, t.stage, t.status, t.start_commit, t.branch, i.approved_commit
     FROM ticket t JOIN integration_intent i ON i.factory_id = t.factory_id AND i.ticket_number = t.number
     JOIN approval a ON a.id = i.approval_id
     WHERE t.factory_id = ? AND t.number = ? AND i.approval_id = ? AND a.decision = 'approved'`,
    [operation.factoryId, operation.ticket, intent.approvalId],
  );

  const ticket = rows[0];
  let recorded: OperationDetail = {};

  const outcome: OperationOutcome = yield* Effect.gen(function* () {
    const approved = intent.approvedCommit;

    if (ticket === undefined || ticket.state !== "stage" || ticket.status !== "awaiting_approval" ||
      approved !== ticket.approved_commit || !/^[a-f0-9]{40,64}$/.test(approved)) {
      return yield* new IntegrationRefused({ reason: "integration no longer has an eligible approved ticket" });
    }

    if (ticket.branch === null) {return yield* new IntegrationRefused({ reason: "ticket branch identity is missing" });}

    const ticketRef = `refs/heads/${ticket.branch}`;
    yield* git(["check-ref-format", ticketRef]);
    const lockPath = resolve(clonePath, yield* git(["rev-parse", "--git-path", `${ticketRef}.lock`]));
    // Hold Git's own branch lock through result commit. Unlike a process-local mutex, this
    // also prevents an external commit/update-ref from moving HEAD after validation. Never
    // remove a pre-existing lock; ambiguous crashes retain the normal Git recovery fence.
    yield* Effect.acquireRelease(Effect.try({ try: () => {
      mkdirSync(dirname(lockPath), { recursive: true });

      return openSync(lockPath, "wx", 0o600);
    }, catch: (cause) => new IntegrationRefused({ reason: `cannot lock ticket branch: ${messageOf(cause)}` }) }),
    (descriptor) => Effect.sync(() => { closeSync(descriptor); unlinkSync(lockPath); }));

    if ((yield* git(["rev-parse", "--verify", `${ticketRef}^{commit}`])) !== approved) {
      return yield* new IntegrationRefused({ reason: "ticket head changed after approval; evaluations must be voided" });
    }

    const ref = `refs/heads/${target.defaultBranch}`;
    const previousHead = yield* git(["rev-parse", "--verify", `${ref}^{commit}`]);
    recorded = { previousHead, approvedCommit: approved };
    yield* extendOperationIntent(store, operation.id, { ...recorded, defaultBranch: target.defaultBranch });

    if (previousHead !== ticket.start_commit) {
      // A detached scratch checkout keeps both named branches and their worktrees untouched.
      // Disable rerere: a remembered resolution must not conceal conflicting-file evidence.
      const conflictingFiles = yield* Effect.scoped(Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "foundry-integration-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );

        const path = join(directory, "merge");
        yield* Effect.acquireRelease(
          git(["worktree", "add", "--detach", path, previousHead]),
          () => git(["worktree", "remove", "--force", path]).pipe(Effect.orDie),
        );
        const scratchGit = (args: ReadonlyArray<string>) => integrationGit(path, env, args);

        const merged = yield* scratchGit(["-c", "user.name=Foundry", "-c", "user.email=foundry@foundry.invalid",
          "-c", "rerere.enabled=false", "-c", "rerere.autoupdate=false",
          "merge", "--no-commit", "--no-ff", "--no-gpg-sign", approved]).pipe(Effect.as(undefined), Effect.catchTag("IntegrationRefused", (error) => Effect.succeed(error)));

        const files = yield* Effect.tryPromise({
          try: () => runCloneGit(["diff", "--name-only", "--diff-filter=U", "-z"], env, path, true),
          catch: (cause) => new IntegrationRefused({ reason: messageOf(cause) }),
        });

        const conflicts = files.split("\u0000").filter((file) => file !== "");

        if (merged !== undefined && conflicts.length === 0) {return yield* merged;}

        if (conflicts.length > 0) {yield* scratchGit(["merge", "--abort"]);}

        return conflicts;
      }));

      if (conflictingFiles.length > 0) {
        recorded = { ...recorded, conflictingFiles };

        return yield* new IntegrationRefused({ reason: `Merge conflict in: ${conflictingFiles.join(", ")}` });
      }

      return yield* new IntegrationRefused({ reason: "default branch moved; integration requires moved-default verification" });
    }

    // Refuse dirty state rather than carrying it into the integration. Never reset or clean it.
    if ((yield* git(["status", "--porcelain", "--untracked-files=all"])) !== "") {
      return yield* new IntegrationRefused({ reason: "factory clone has uncommitted changes" });
    }

    const exact = yield* git(["rev-parse", "--verify", `${approved}^{commit}`]);

    if (exact !== approved) {return yield* new IntegrationRefused({ reason: "approved SHA is not an exact commit" });}

    const common = yield* git(["merge-base", previousHead, approved]);
    const fastForward = common === previousHead;
    let plannedHead = approved;

    if (!fastForward) {
      // A writing stage may have rebased before review. Build a real merge tree without
      // touching the default checkout, and preserve the exact approved SHA as second parent.
      const tree = yield* git(["merge-tree", "--write-tree", previousHead, approved]);

      if (!/^[a-f0-9]{40,64}$/.test(tree)) {
        return yield* new IntegrationRefused({ reason: "merge-tree did not produce one clean tree" });
      }

      plannedHead = yield* git(["-c", "user.name=Foundry", "-c", "user.email=foundry@foundry.invalid",
        "commit-tree", "--no-gpg-sign", tree, "-p", previousHead, "-p", approved, "-m", `Integrate approved commit ${approved}`]);
    }

    // Recovery can distinguish the approved commit from the merge commit that contains it.
    yield* extendOperationIntent(store, operation.id, { plannedHead, fastForward });

    const [authorized] = yield* store.read<{ approved_commit: string }>(`SELECT i.approved_commit FROM integration_intent i
      JOIN ticket t ON t.factory_id = i.factory_id AND t.number = i.ticket_number
      WHERE i.approval_id = ? AND i.factory_id = ? AND i.ticket_number = ? AND t.state = 'stage' AND t.status = 'awaiting_approval'`,
      [intent.approvalId, operation.factoryId, operation.ticket]);

    if (authorized?.approved_commit !== approved) {return yield* new IntegrationRefused({ reason: "integration authorization changed before ref mutation" });}

    // From the first checkout/ref mutation onward, a subprocess error is ambiguous: Git may
    // have changed state before losing its result. Leave the operation running for recovery.
    yield* git(["switch", "--quiet", "--no-guess", "--no-recurse-submodules", "--", target.defaultBranch]).pipe(Effect.orDie);
    // The prepared result contains the recorded default head, so landing it is always a FF.
    // Explicit policy is independent of operator merge.ff and signing configuration.
    yield* git(["merge", "--ff-only", "--no-gpg-sign", "--quiet", plannedHead]).pipe(Effect.orDie);
    const head = yield* git(["rev-parse", "--verify", `${ref}^{commit}`]).pipe(Effect.orDie);

    if (head !== plannedHead) {return yield* Effect.die(new Error("integration head is not the prepared approved result"));}

    return { status: "complete", result: { ...recorded, head, fastForward, cleanup: "pending" } } satisfies OperationOutcome;
  }).pipe(Effect.catchTag("IntegrationRefused", ({ reason }) =>
    Effect.succeed({ status: "failed", result: { ...recorded, reason } } satisfies OperationOutcome)));

  // Result and ticket completion commit together. Cleanup cannot change completion, and is
  // deliberately left pending with worktree/branch metadata intact for the cleanup service.
  yield* store.change((change) => Effect.gen(function* () {
    yield* recordOperationResult(change, operation.id, outcome);

    const [current] = yield* change.query<{ stage: string; approved_commit: string }>(`SELECT t.stage, i.approved_commit FROM ticket t
      JOIN integration_intent i ON i.factory_id = t.factory_id AND i.ticket_number = t.number
      WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status = 'awaiting_approval' AND i.approval_id = ?`,
      [operation.factoryId, operation.ticket, intent.approvalId]);

    if (ticket === undefined || current?.stage !== ticket.stage || current.approved_commit !== ticket.approved_commit) {return;}

    const complete = outcome.status === "complete";
    const conflict = Array.isArray(outcome.result["conflictingFiles"]);
    const stages = target.config?.production_lines[ticket.production_line]?.stages ?? [];
    const rejectedStage = conflict ? outcomeRoute(stages, ticket.stage, "rejected") : undefined;
    const nextStage = rejectedStage ?? ticket.stage;
    const limitReached = conflict && ticket.rejections + 1 >= ticket.rejection_ceiling;
    const nextStatus = conflict && rejectedStage !== undefined && !limitReached ? "queued" : "paused";
    const now = yield* Clock.currentTimeMillis;

    if (conflict) {
      yield* change.query(`UPDATE ticket SET rejections = rejections + 1 WHERE factory_id = ? AND number = ?`, [operation.factoryId, operation.ticket]);
      yield* change.query(`DELETE FROM integration_intent WHERE approval_id = ?`, [intent.approvalId]);
    }

    yield* change.query(`UPDATE ticket SET state = ?, stage = ?, status = ? WHERE factory_id = ? AND number = ?`,
      [complete ? "completed" : "stage", complete ? null : nextStage, complete ? null : nextStatus, operation.factoryId, operation.ticket]);

    const transitions = yield* change.query<{ sequence: number }>(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
      from_state, from_stage, from_status, to_state, to_stage, to_status, reason, git_commit, outcome, evidence)
      VALUES (?, ?, ?, 'daemon', 'stage', ?, 'awaiting_approval', ?, ?, ?, ?, ?, ?, ?) RETURNING sequence`,
      [operation.factoryId, operation.ticket, now, ticket.stage, complete ? "completed" : "stage",
        complete ? null : nextStage, complete ? null : nextStatus, complete ? "Integrated approved commit" : String(outcome.result["reason"]), ticket.approved_commit,
        conflict ? "rejected" : null, JSON.stringify(conflict ? outcome.result["conflictingFiles"] : [])]);

    if (conflict && nextStatus === "paused") {
      const transition = expectDefined(transitions[0], "integration rejection transition").sequence;

      const approvals = yield* change.query<{ id: number }>(`INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
        SELECT factory_id, ticket_number, assignment_id, ?, ?, 'open', ? FROM approval WHERE id = ? RETURNING id`,
        [transition, limitReached ? "limit_reached" : "blocked", now, intent.approvalId]);

      yield* change.recordHistory({ factoryId: operation.factoryId, kind: "approval.requested", subject: String(expectDefined(approvals[0], "integration rejection approval").id),
        detail: { kind: limitReached ? "limit_reached" : "blocked", ticket: operation.ticket, transition }, records: [ticketRecord(operation.ticket ?? 0)] });
    }

    yield* change.recordHistory({ factoryId: operation.factoryId, kind: "ticket.transitioned", subject: String(operation.ticket),
      detail: { state: complete ? "completed" : "stage", stage: complete ? null : nextStage, status: complete ? null : nextStatus, operationId: operation.id,
        approvedCommit: ticket.approved_commit, cleanup: complete ? "pending" : null }, records: [ticketRecord(operation.ticket ?? 0)] });
  }));
})));
