/** The Foundry daemon: an Effect 4 program and the only process that opens the database. */
export const packageName = "@foundry/daemon" as const;

export * from "./channel/server.js";

export { channelLogEvents } from "./channel/log-events.js";

export * from "./channel/slot-claim.js";

export { selectStateRoot, type StateRootInputs } from "@foundry/protocol/state-root";

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

export * from "./tickets.js";

export * from "./prime.js";

export * from "./priming.js";

export {
  DAEMON_LOG_KEEP_FILES,
  DAEMON_LOG_MAX_BYTES,
  DAEMON_LOG_NAME,
  LOG_LEVELS,
  OMITTED,
  REDACTED,
  daemonLogPath,
  isLogLevel,
  openDaemonLog,
  type DaemonLogger,
  type DaemonLoggerOptions,
  type LogDetailValue,
  type LogEntry,
  type LogLevel,
  type LogRefs,
} from "./log.js";

export {
  ManagementSocketError,
  serveManagementApi,
  type ManagementApi,
  type ManagementApiInputs,
  type ManagementSocketRefusal,
} from "./management-api.js";

export {
  closeHold,
  getHold,
  listOpenHolds,
  raiseHold,
  storeHoldsReader,
  type HoldsReader,
  type RaiseHold,
  type RaiseOutcome,
  type RaiseResult,
} from "./holds.js";

export { readEvents, storeEventSource, type EventPageQuery, type EventSource } from "./events.js";

export { formatEvent } from "./events-stream.js";

export * from "./factory-loads.js";

export {
  CLONE_MARKER_FILE_NAME,
  CLONES_DIR_NAME,
  clearCloneStaging,
  cloneGitEnv,
  cloneRefusalOf,
  cloneSource,
  ensureFactoryClone,
  factoryClonePath,
  FactoryCloneError,
  recordCloneRefusals,
  runCloneGit,
  type CloneMarker,
  type CloneRefusal,
  type CloneRefusalReason,
  type EnsureCloneOptions,
  type EnsuredClone,
} from "./factory-clone.js";

export * from "./start-refusal.js";

export * from "./operations.js";

export * from "./factory-sync.js";

export { listLoadedFactories, RunNotRecordedError, storeFactoriesReader, type FactoriesReader } from "./factories.js";
