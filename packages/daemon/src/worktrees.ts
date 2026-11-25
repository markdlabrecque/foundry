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
import { closeOpenHoldIn, raiseHoldIn } from "./holds.js";
import { beginOperationIn, extendOperationIntent, recordOperationResult } from "./operations.js";
import type { Operation } from "./operations.js";
import type { Change, Store, StoreError } from "./store.js";
import { pathSegment } from "./tickets.js";

export interface WorktreeTarget {
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
 * attempt in any status blocks a blind replay; interrupted creation is reconciled by recovery
 * (worktree-recovery.ts).
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

    yield* buildTicketWorktree({ store: options.store, factory, clonePath, ticket, operation,
      path, branch, defaultBranch, env: options.env ?? process.env });
  });

/**
 * A creation that needs the operator: its recorded intent, what Git held when it was last looked
 * at, and why it failed. Shown as a failed-worktree hold's evidence (PRD §10.2).
 */
export type FailedCreation = {
  readonly path: string;
  readonly branch: string;
  readonly defaultBranch: string;
  /** `null` when the creation failed before it recorded its base, so it changed no Git state. */
  readonly startCommit: string | null;
  /** The branch's commit when last inspected; `""` when the branch was missing, `null` when not inspected. */
  readonly head: string | null;
  readonly reason: string;
};

/**
 * Raises, or refreshes, the failed-worktree hold on a ticket in the change that records its
 * creation failed. `operationId` is the failed `worktree_create`.
 */
export const raiseFailedWorktreeIn = (change: Change, failed: FailedCreation & {
  readonly factoryId: string; readonly ticket: number; readonly operationId: number;
}) => {
  const { factoryId, ticket, ...evidence } = failed;

  return raiseHoldIn(change, { factoryId, kind: "failed_worktree", subject: String(ticket), evidence });
};

/** Where a ticket's worktree lives, fixed when it is created (PRD §9.2). */
export interface WorktreeIdentity {
  readonly path: string;
  readonly branch: string;
  readonly startCommit: string;
}

/** The first after_create of a newly published worktree, begun in the publishing change. */
export interface FirstSetup {
  readonly hook: Operation;
  readonly argv: ReadonlyArray<string>;
  readonly path: string;
  readonly logPath: string;
}

/**
 * Records the worktree on its ticket and, when `argv` is given, begins its first after_create in
 * the same change, so a concurrent scheduler cannot skip setup. The caller settles the creation
 * operation in that change too.
 */
export const publishTicketWorktreeIn = (
  change: Change,
  ticket: QueuedTicket,
  worktreeOperationId: number,
  identity: WorktreeIdentity,
  argv: ReadonlyArray<string> | undefined,
) => Effect.gen(function* () {
  const { path, branch, startCommit } = identity;
  yield* change.query(
    `UPDATE ticket SET worktree_path = ?, branch = ?, start_commit = ? WHERE factory_id = ? AND number = ?`,
    [path, branch, startCommit, ticket.factory_id, ticket.number],
  );
  yield* change.recordHistory({
    factoryId: ticket.factory_id, kind: "ticket.worktree_created", subject: String(ticket.number),
    detail: { path, branch, startCommit }, records: [ticketRecord(ticket.number)],
  });
  // Only an operator retry or discard publishes while one is open (worktree-retry.ts).
  yield* closeOpenHoldIn(change, { factoryId: ticket.factory_id, kind: "failed_worktree", subject: String(ticket.number) }, "resolved");

  if (argv === undefined) {return undefined;}

  const logPath = join(ticket.directory, "evidence", `after-create-${randomUUID()}.log`);

  const hook = yield* beginOperationIn(change, { factoryId: ticket.factory_id, kind: "hook", ticket: ticket.number,
    intent: { hook: "after_create", operation: "worktree_create", worktreeOperationId, argv: [...argv], path, logPath } });

  const setup: FirstSetup = { hook, argv, path, logPath };

  return setup;
});

/** Runs a published worktree's first after_create, if one was begun. */
export const runFirstSetup = (store: Store, factory: LoadedFactory, ticket: QueuedTicket, setup: FirstSetup | undefined, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    if (setup === undefined) {return;}

    const stage = ticket.stage ?? factory.config.production_lines[ticket.production_line]?.stages[0]?.id;

    if (stage === undefined) {return yield* Effect.die(new Error("worktree ticket has no stage"));}

    yield* runFirstAfterCreate({ store, operation: setup.hook, ticket, stage, argv: setup.argv, path: setup.path, logPath: setup.logPath, env });
  });

export interface WorktreeBuild {
  readonly store: Store;
  readonly factory: LoadedFactory;
  readonly clonePath: string;
  readonly ticket: QueuedTicket;
  /** A `worktree_create` operation already committed as running, with its intent. */
  readonly operation: Operation;
  readonly path: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A creation's end: published with the first after_create still to run, or failed with its hold raised. */
export type CreatedWorktree =
  | { readonly created: true; readonly setup: FirstSetup | undefined; readonly startCommit: string }
  | { readonly created: false; readonly reason: string };

/**
 * Creates the branch and worktree for a running `worktree_create` from the clone's current
 * default-branch head and publishes them with the operation's result, leaving the first
 * after_create to the caller. A failed Git step records the operation failed and raises a
 * failed-worktree hold on the ticket in the same change.
 */
export const createTicketWorktree = (build: WorktreeBuild): Effect.Effect<CreatedWorktree, StoreError> => {
  const { store, factory, clonePath, ticket, operation, path, branch, defaultBranch, env } = build;
  // The base the failure reports, once this build has recorded it.
  let recordedStart: string | null = null;

  const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(args, env, clonePath), catch: (cause) => new WorktreeStepFailed({ reason: messageOf(cause) }),
  });

  return Effect.gen(function* () {
    const startCommit = yield* git(["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`]);

    // The exact base is durable before branch/worktree creation can change Git state.
    yield* extendOperationIntent(store, operation.id, { startCommit });
    recordedStart = startCommit;
    yield* Effect.try({
      try: () => mkdirSync(dirname(path), { recursive: true }),
      catch: (cause) => new WorktreeStepFailed({ reason: messageOf(cause) }),
    });
    yield* git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "-b", branch, "--", path, startCommit]);

    const setup = yield* store.change((change) => Effect.gen(function* () {
      yield* recordOperationResult(change, operation.id, { status: "complete", result: { path, branch, startCommit } });

      return yield* publishTicketWorktreeIn(change, ticket, operation.id, { path, branch, startCommit }, factory.config.worktrees?.after_create);
    }));

    const created: CreatedWorktree = { created: true, setup, startCommit };

    return created;
  }).pipe(Effect.catchTag("WorktreeStepFailed", ({ reason }) =>
    store.change((change) => Effect.gen(function* () {
      yield* recordOperationResult(change, operation.id, { status: "failed", result: { reason } });
      yield* raiseFailedWorktreeIn(change, {
        factoryId: ticket.factory_id, ticket: ticket.number, operationId: operation.id, path, branch, defaultBranch,
        startCommit: recordedStart, head: null, reason,
      });

      const failed: CreatedWorktree = { created: false, reason };

      return failed;
    })),
  ));
};

/** Creates and publishes the worktree (`createTicketWorktree`), then runs its first after_create. */
export const buildTicketWorktree = (build: WorktreeBuild) => Effect.gen(function* () {
  const created = yield* createTicketWorktree(build);

  if (created.created) {yield* runFirstSetup(build.store, build.factory, build.ticket, created.setup, build.env);}
});
