/** The Foundry daemon: an Effect 4 program and the only process that opens the database. */
export const packageName = "@foundry/daemon" as const;

export * from "./message-delivery.js";

export * from "./channel/server.js";

export { channelLogEvents } from "./channel/log-events.js";

export * from "./channel/slot-claim.js";

export * from "./submissions.js";

export * from "./agent-message.js";

export * from "./operator-message.js";

export * from "./agent-request.js";

export * from "./request-expiry.js";

export * from "./agent-reply.js";

export * from "./task-transition.js";

export * from "./message-routing.js";

export * from "./agent-discover.js";

export * from "./agent-status.js";

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

export * from "./assignments.js";

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
  closeOpenHoldIn,
  getHold,
  listOpenHolds,
  raiseHold,
  raiseHoldIn,
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

export {
  createFactoryStates,
  createFactoryStopper,
  DEFAULT_STOP_GRACE_MS,
  DEFAULT_STOP_KILL_WAIT_MS,
  FactoryStopError,
  type FactoryStates,
  type FactoryStopErrorCode,
  type FactoryStopper,
  type FactoryStopperOptions,
  type StopHost,
} from "./factory-stop.js";

export {
  createInstanceShutdown,
  ShutdownError,
  type InstanceShutdown,
  type InstanceShutdownOptions,
  type ShutdownErrorCode,
  type ShutdownHost,
} from "./shutdown.js";

export {
  connectOrStartHost,
  createSlotScheduler,
  planSlots,
  recordedCurrentLaunch,
  storedConversation,
  slotDirectory,
  SlotsError,
  SLOTS_DIR_NAME,
  storeSlotInterrupter,
  storeSlotsReader,
  type LaunchExitResult,
  type SlotChannel,
  type SlotInterrupter,
  type SlotInterrupterOptions,
  type PlannedSlot,
  type SlotHost,
  type SlotScheduleOutcome,
  type SlotScheduleResult,
  type SlotScheduler,
  type SlotSchedulerOptions,
  type SlotsErrorCode,
  type SlotsReader,
} from "./slots.js";

export {
  createSlotFreezer,
  openSlotGate,
  storeSlotControl,
  whenSendable,
  type CauseCheck,
  type CauseCheckResult,
  type FreezeChecks,
  type FreezeOutcome,
  type FreezeRequest,
  type SlotFreezer,
  type SlotFreezerOptions,
  type SlotGate,
  type SlotRef,
  type UnfreezeResult,
} from "./freeze.js";

export {
  instructionFilesCheck,
  instructionMissingEvidence,
  plannedPrimeRequests,
  type SlotPrimeRequest,
} from "./instruction-freeze.js";

export type { SlotControl } from "./slots-error.js";

export {
  classifyOwnership,
  type HostReport,
  type RecordedLaunch,
  type RecordedSlot,
  type SlotOwnership,
  type UnprovenReason,
} from "./ownership.js";

export {
  canonicalSource,
  compareToolSet,
  createToolSetGuard,
  createToolSetRecheck,
  expectedToolSet,
  frozenConversation,
  isMatch,
  TOOL_SET_MISMATCH,
  type ExpectedTool,
  type HelloCheck,
  type ReplacedTool,
  type ToolSetDiscrepancy,
  type ToolSetGuard,
  type ToolSetGuardOptions,
  type ToolSetRecheckOptions,
} from "./tool-set-check.js";
