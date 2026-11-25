/** The foundry operator CLI: an Effect 4 program that talks to the management API. */
export const packageName = "@foundry/cli" as const;
export { runCli, EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE, type CliIo } from "./run.js";
