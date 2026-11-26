/** Operator ticket worktree inspection and cleanup (PRD §9.4, §9.6, §11.5). */
import { Schema } from "effect";
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

export const WORKTREES_PATH = `${MANAGEMENT_API_PREFIX}/worktrees`;

export const WorktreeSummary = Schema.Struct({
  factoryId: Schema.String,
  ticket: Schema.Number,
  state: Schema.String,
  path: Schema.String,
  branch: Schema.String,
});

export type WorktreeSummary = typeof WorktreeSummary.Type;

export const WorktreeListResult = Schema.Struct({ worktrees: Schema.Array(WorktreeSummary) });
export const isWorktreeListResult = Schema.is(WorktreeListResult);

export const WorktreeInspection = Schema.Struct({
  ...WorktreeSummary.fields,
  /** Git porcelain status, including untracked and ignored files. */
  files: Schema.String,
  /** Commits reachable from the ticket but not the default branch. */
  commits: Schema.String,
  /** Binds force confirmation to this exact inspected Git state. */
  confirmation: Schema.String,
});

export type WorktreeInspection = typeof WorktreeInspection.Type;

export const isWorktreeInspection = Schema.is(WorktreeInspection);

export const WorktreeCleanRequest = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
  confirmation: Schema.optionalKey(Schema.String),
});

export type WorktreeCleanRequest = typeof WorktreeCleanRequest.Type;

export const WorktreeCleanResult = Schema.Struct({ factoryId: Schema.String, ticket: Schema.Number, operationId: Schema.Number });
export const isWorktreeCleanResult = Schema.is(WorktreeCleanResult);

export const worktreePath = (ticket: number, factory?: string): string =>
  `${WORKTREES_PATH}/${ticket}${factory === undefined ? "" : `?factory=${encodeURIComponent(factory)}`}`;

/**
 * A ticket whose worktree creation failed (failed-worktree hold, PRD §10.2): what `discard` would
 * remove. `GET <worktreeFailedPath>`.
 */
export const FailedWorktreeInspection = Schema.Struct({
  factoryId: Schema.String,
  ticket: Schema.Number,
  /** The failed `worktree_create`. */
  operationId: Schema.Number,
  path: Schema.String,
  branch: Schema.String,
  reason: Schema.String,
  /** The branch's commit, `""` when it does not exist. */
  head: Schema.String,
  /** Commits on the branch not in the default branch. */
  commits: Schema.String,
  /** Git porcelain status of the partial worktree, including untracked and ignored files. */
  files: Schema.String,
  /** Whether discard would lose commits or files, and so needs `confirmation`. */
  needsConfirmation: Schema.Boolean,
  /** Binds discard to this exact inspected Git state. */
  confirmation: Schema.String,
});

export type FailedWorktreeInspection = typeof FailedWorktreeInspection.Type;

export const isFailedWorktreeInspection = Schema.is(FailedWorktreeInspection);

/** `POST <worktreeFailedPath>/discard` body. */
export const WorktreeDiscardRequest = Schema.Struct({
  confirmation: Schema.optionalKey(Schema.String),
});

export type WorktreeDiscardRequest = typeof WorktreeDiscardRequest.Type;

/** Result of `retry` and `discard`: the replacing creation, published on the ticket. */
export const WorktreeRecreateResult = Schema.Struct({
  factoryId: Schema.String,
  ticket: Schema.Number,
  operationId: Schema.Number,
  path: Schema.String,
  branch: Schema.String,
  startCommit: Schema.String,
});

export type WorktreeRecreateResult = typeof WorktreeRecreateResult.Type;

export const isWorktreeRecreateResult = Schema.is(WorktreeRecreateResult);

/**
 * `GET`: inspect a failed creation; `POST .../retry` and `POST .../discard` act on it
 * (`foundry worktree retry | discard`).
 */
export const worktreeFailedPath = (ticket: number, action?: "retry" | "discard", factory?: string): string =>
  `${WORKTREES_PATH}/${ticket}/failed${action === undefined ? "" : `/${action}`}${factory === undefined ? "" : `?factory=${encodeURIComponent(factory)}`}`;
