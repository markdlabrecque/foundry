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
