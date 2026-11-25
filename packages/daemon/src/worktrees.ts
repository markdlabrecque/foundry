/** Ticket worktrees (PRD §9.2, §9.4). Git never runs inside a store transaction. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { messageOf } from "@foundry/protocol/errors";
import { Data, Effect } from "effect";
import type { QueuedTicket } from "./assignments.js";
import { runFirstAfterCreate } from "./after-create.js";
import { resolveConfiguredPath } from "./config/index.js";
import { runCloneGit } from "./factory-clone.js";
import type { LoadedFactory } from "./factory-loads.js";
import { ticketRecord } from "./history-records.js";
import { beginOperationIn, extendOperationIntent, recordOperationResult } from "./operations.js";
import type { Store } from "./store.js";
import { pathSegment } from "./tickets.js";

interface WorktreeTarget {
  readonly factory: LoadedFactory;
  readonly clonePath: string;
}

export interface TicketWorktreesOptions {
  readonly store: Store;
  readonly target: (factory: string) => WorktreeTarget | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

class AlreadyPrepared extends Data.TaggedError("AlreadyPrepared") {}

class WorktreeStepFailed extends Data.TaggedError("WorktreeStepFailed")<{ readonly reason: string }> {}

/**
 * Claim once durably, then create from the clone's current default-branch head. A previous
 * attempt in any status blocks a blind replay; interrupted creation is reconciled by recovery.
 * The first after_create runs before assignment; cleanup and recovery have separate handlers.
 */
export const createTicketWorktrees = (options: TicketWorktreesOptions) => (ticket: QueuedTicket) =>
  Effect.gen(function* () {
    const target = options.target(ticket.factory_id);

    if (target === undefined) {return;}

    const { factory, clonePath } = target;
    const root = resolveConfiguredPath(factory.config.worktrees?.root ?? "~/worktrees", dirname(factory.yamlFile), options.home);
    const path = join(root, pathSegment(ticket.factory_id), `${ticket.number}-${ticket.slug}`);

    const branch = (factory.config.worktrees?.branch_pattern ?? "ticket/{ticket-id}-{slug}")
      .replaceAll("{ticket-id}", String(ticket.number)).replaceAll("{slug}", ticket.slug);

    const defaultBranch = factory.config.repository.default_branch;

    const operation = yield* options.store.change((change) => Effect.gen(function* () {
      const eligible = yield* change.query(
        `SELECT 1 FROM ticket t WHERE factory_id = ? AND number = ? AND worktree_path IS NULL
         AND (state = 'backlog' OR (state = 'stage' AND status = 'queued'))
         AND NOT EXISTS (SELECT 1 FROM operation WHERE factory_id = t.factory_id
           AND ticket_number = t.number AND kind = 'worktree_create')`,
        [ticket.factory_id, ticket.number],
      );

      if (eligible.length === 0) {return yield* new AlreadyPrepared();}

      return yield* beginOperationIn(change, {
        factoryId: ticket.factory_id, kind: "worktree_create", ticket: ticket.number,
        intent: { clonePath, path, branch, defaultBranch },
      });
    })).pipe(Effect.catchTag("AlreadyPrepared", () => Effect.succeed(undefined)));

    if (operation === undefined) {return;}

    const env = options.env ?? process.env;

    const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
      try: () => runCloneGit(args, env, clonePath), catch: (cause) => new WorktreeStepFailed({ reason: messageOf(cause) }),
    });

    yield* Effect.gen(function* () {
      const startCommit = yield* git(["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`]);

      // The exact base is durable before branch/worktree creation can change Git state.
      yield* extendOperationIntent(options.store, operation.id, { startCommit });
      yield* Effect.try({
        try: () => mkdirSync(dirname(path), { recursive: true }),
        catch: (cause) => new WorktreeStepFailed({ reason: messageOf(cause) }),
      });
      yield* git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "-b", branch, "--", path, startCommit]);

      const argv = factory.config.worktrees?.after_create;
      const logPath = join(ticket.directory, "evidence", `after-create-${randomUUID()}.log`);

      // Publish the worktree and hook intent atomically. A concurrent scheduler cannot skip setup.
      const hook = yield* options.store.change((change) => Effect.gen(function* () {
        yield* change.query(
          `UPDATE ticket SET worktree_path = ?, branch = ?, start_commit = ? WHERE factory_id = ? AND number = ?`,
          [path, branch, startCommit, ticket.factory_id, ticket.number],
        );
        yield* recordOperationResult(change, operation.id, {
          status: "complete", result: { path, branch, startCommit },
        });
        yield* change.recordHistory({
          factoryId: ticket.factory_id, kind: "ticket.worktree_created", subject: String(ticket.number),
          detail: { path, branch, startCommit }, records: [ticketRecord(ticket.number)],
        });

        if (argv === undefined) {return undefined;}

        return yield* beginOperationIn(change, { factoryId: ticket.factory_id, kind: "hook", ticket: ticket.number,
          intent: { hook: "after_create", operation: "worktree_create", worktreeOperationId: operation.id, argv: [...argv], path, logPath } });
      }));

      if (hook !== undefined && argv !== undefined) {
        const line = factory.config.production_lines[ticket.production_line];
        const stage = ticket.stage ?? line?.stages[0]?.id;

        if (stage === undefined) {return yield* Effect.die(new Error("worktree ticket has no stage"));}

        yield* runFirstAfterCreate({ store: options.store, operation: hook, ticket, stage, argv, path, logPath, env });
      }
    }).pipe(Effect.catchTag("WorktreeStepFailed", ({ reason }) =>
      options.store.change((change) => recordOperationResult(change, operation.id, { status: "failed", result: { reason } })),
    ));
  });
