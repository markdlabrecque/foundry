/** The foundry operator CLI: an Effect 4 program that talks to the management API. */
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
export { runHoldList, runHoldShow, type HoldOptions, type HoldOutcome } from "./holds.js";
export { renderEvent, runEvents, sseParser, type EventsOptions, type EventsOutcome } from "./events.js";
