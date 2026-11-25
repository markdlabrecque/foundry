/** Exact-SHA integration for the unchanged-default path (PRD §9.3–4).
 * Moved-default verification/conflict handling and worktree cleanup have separate owners.
 * No fetch, push, ticket-branch rewrite, or cleanup runs here.
 */
import { Clock, Data, Effect, Schema } from "effect";
import { messageOf } from "@foundry/protocol/errors";
import { runCloneGit } from "./factory-clone.js";
import type { SyncTarget } from "./factory-sync.js";
import { ticketRecord } from "./history-records.js";
import { extendOperationIntent, recordOperationResult } from "./operations.js";
import type { Operation, OperationDetail, OperationOutcome } from "./operations.js";
import type { Store, StoreError } from "./store.js";

class IntegrationRefused extends Data.TaggedError("IntegrationRefused")<{ readonly reason: string }> {}

interface IntegrationTicket {
  readonly state: string;
  readonly stage: string;
  readonly status: string;
  readonly start_commit: string | null;
  readonly approved_commit: string;
}

const decodeIntent = Schema.decodeUnknownSync(Schema.Struct({ approvalId: Schema.Number, approvedCommit: Schema.String }));

const integrationGit = (clonePath: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => Effect.tryPromise({
  try: () => runCloneGit(["-c", "core.hooksPath=/dev/null", ...args], env, clonePath),
  catch: (cause) => new IntegrationRefused({ reason: messageOf(cause) }),
});

/** Already admitted by the shared integration/sync queue. Git always runs outside transactions. */
export const integrateApprovedCommit = (
  store: Store, operation: Operation, target: SyncTarget, env: NodeJS.ProcessEnv,
): Effect.Effect<void, StoreError> => Effect.gen(function* () {
  const intent = decodeIntent(operation.intent);
  const clonePath = target.clonePath;
  const git = (args: ReadonlyArray<string>) => integrationGit(clonePath, env, args);

  const rows = yield* store.read<IntegrationTicket>(
    `SELECT t.state, t.stage, t.status, t.start_commit, i.approved_commit
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

    const ref = `refs/heads/${target.defaultBranch}`;
    const previousHead = yield* git(["rev-parse", "--verify", `${ref}^{commit}`]);
    recorded = { previousHead, approvedCommit: approved };
    yield* extendOperationIntent(store, operation.id, { ...recorded, defaultBranch: target.defaultBranch });

    if (previousHead !== ticket.start_commit) {
      return yield* new IntegrationRefused({ reason: "default branch moved; integration requires moved-default verification" });
    }

    // Refuse dirty state rather than carrying it into the integration. Never reset or clean it.
    if ((yield* git(["status", "--porcelain", "--untracked-files=all"])) !== "") {
      return yield* new IntegrationRefused({ reason: "factory clone has uncommitted changes" });
    }

    const exact = yield* git(["rev-parse", "--verify", `${approved}^{commit}`]);

    if (exact !== approved) {return yield* new IntegrationRefused({ reason: "approved SHA is not an exact commit" });}

    yield* git(["switch", "--quiet", "--no-guess", "--no-recurse-submodules", "--", target.defaultBranch]);
    // With the original base still current, only a descendant can land. ff-only is independent
    // of operator merge policy and cannot manufacture or substitute an unreviewed commit.
    yield* git(["merge", "--ff-only", "--no-gpg-sign", "--quiet", approved]);
    const head = yield* git(["rev-parse", "--verify", `${ref}^{commit}`]).pipe(Effect.orDie);

    if (head !== approved) {return yield* Effect.die(new Error("integration head is not the approved SHA"));}

    return { status: "complete", result: { ...recorded, head, fastForward: true, cleanup: "pending" } } satisfies OperationOutcome;
  }).pipe(Effect.catchTag("IntegrationRefused", ({ reason }) =>
    Effect.succeed({ status: "failed", result: { ...recorded, reason } } satisfies OperationOutcome)));

  // Result and ticket completion commit together. Cleanup cannot change completion, and is
  // deliberately left pending with worktree/branch metadata intact for the cleanup service.
  yield* store.change((change) => Effect.gen(function* () {
    yield* recordOperationResult(change, operation.id, outcome);

    if (ticket === undefined || ticket.state !== "stage" || ticket.status !== "awaiting_approval") {return;}

    const complete = outcome.status === "complete";
    const now = yield* Clock.currentTimeMillis;
    yield* change.query(`UPDATE ticket SET state = ?, stage = ?, status = ? WHERE factory_id = ? AND number = ?`,
      [complete ? "completed" : "stage", complete ? null : ticket.stage, complete ? null : "paused", operation.factoryId, operation.ticket]);
    yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
      from_state, from_stage, from_status, to_state, to_stage, to_status, reason, git_commit)
      VALUES (?, ?, ?, 'daemon', 'stage', ?, 'awaiting_approval', ?, ?, ?, ?, ?)`,
      [operation.factoryId, operation.ticket, now, ticket.stage, complete ? "completed" : "stage",
        complete ? null : ticket.stage, complete ? null : "paused", complete ? "Integrated approved commit" : String(outcome.result["reason"]), ticket.approved_commit]);
    yield* change.recordHistory({ factoryId: operation.factoryId, kind: "ticket.transitioned", subject: String(operation.ticket),
      detail: { state: complete ? "completed" : "stage", status: complete ? null : "paused", operationId: operation.id,
        approvedCommit: ticket.approved_commit, cleanup: complete ? "pending" : null }, records: [ticketRecord(operation.ticket ?? 0)] });
  }));
});
