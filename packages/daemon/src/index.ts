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
