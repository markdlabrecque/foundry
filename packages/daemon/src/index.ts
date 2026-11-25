/** The Foundry daemon: an Effect 4 program and the only process that opens the database. */
export const packageName = "@foundry/daemon" as const;

export { selectStateRoot, type StateRootInputs } from "./state-root.js";
export {
  claimStateRoot,
  LOCK_FILE_NAME,
  StateRootLockedError,
  TAKEOVER_GUARD_FILE_NAME,
  type ClaimStateRootOptions,
  type StateRootClaim,
  type StateRootLockedReason,
} from "./instance-lock.js";
export {
  discoverRepositoryContext,
  type RepositoryContext,
  type RepositoryContextFile,
  type SkillHeader,
} from "./repository-context.js";
export * from "./store.js";
