/** The foundry operator CLI: an Effect 4 program that talks to the management API. */
export { runWorktreeList, runWorktreeClean } from "./worktrees.js";

export const packageName = "@foundry/cli" as const;

export {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  runStatus,
  type StatusOptions,
  type StatusOutcome,
} from "./status.js";

export {
  defaultTitle,
  runTicketList,
  runTicketShow, runTicketPause, runTicketRetry,
  runTicketSubmit,
  type ShowOptions,
  type SubmitOptions,
  type TicketOutcome,
} from "./tickets.js";

export { runLogs, type LogsOptions, type LogsOutcome } from "./logs.js";

export { runMessageSend, type MessageSendOptions } from "./messages.js";

export { runHoldList, runHoldShow, type HoldOptions, type HoldOutcome } from "./holds.js";

export { runApprovalList, runApprovalShow } from "./approvals.js";

export { runFactoryList, type FactoryListOptions, type FactoryOutcome } from "./factories.js";

export { renderEvent, runEvents, sseParser, type EventsOptions, type EventsOutcome } from "./events.js";

export { runFactoryPath, runFactorySync, type FactoryPathOptions, type FactorySyncOptions } from "./factory.js";

export { runFactoryStop, type FactoryStopOptions, type FactoryStopOutcome } from "./factory-stop.js";

export { runShutdown, type ShutdownOptions, type ShutdownOutcome } from "./shutdown.js";

export { runSlotInterrupt, runSlotList, runSlotShow, runSlotUnfreeze, type SlotOptions, type SlotOutcome } from "./slots.js";
