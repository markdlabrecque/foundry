/**
 * `foundry shutdown [--force]` (PRD §10.3, §11.1): one `POST` over the management socket. The
 * daemon stops every factory, then the Worker Host, and answers only once every owned process group
 * is confirmed gone; a failure to confirm is a refusal (exit 1), never success. The daemon exits
 * after it answers a successful shutdown.
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import { isShutdownResult, SHUTDOWN_PATH } from "@foundry/protocol/shutdown-api";
import type { ShutdownRequest, ShutdownResult } from "@foundry/protocol/shutdown-api";
import { DaemonUnreachableError, postToDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

/**
 * How long the CLI waits for the daemon's answer. Factories stop concurrently, so one graceful
 * factory stop bounds it, plus the host's own stop; this is well above their defaults.
 */
const SHUTDOWN_TIMEOUT_MS = 60_000;

export interface ShutdownOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Skip the drain and the grace period. */
  readonly force: boolean;
}

export type ShutdownOutcome = StatusOutcome;

const refused = (message: string): ShutdownOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

const renderShutdown = (result: ShutdownResult): string => {
  const lines: Array<string> = [];

  for (const factory of result.factories) {
    lines.push(`factory ${factory.factoryId} stopped (${factory.launches.length} worker(s))`);
  }

  lines.push(
    result.hostStopped ? "worker host stopped" : "no worker host was running",
    `shutdown complete${result.force ? " (forced)" : ""}`,
  );

  return `${lines.join("\n")}\n`;
};

/** `foundry shutdown`: stops every factory's workers, then the Worker Host, then the daemon. */
export const runShutdown = async (options: ShutdownOptions): Promise<ShutdownOutcome> => {
  if (options.home === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  const body: ShutdownRequest = { force: options.force };
  let reply;

  try {
    reply = await postToDaemon(stateRoot, SHUTDOWN_PATH, body, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }

    return refused(messageOf(error));
  }

  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;

    return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }

  if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

  if (!isShutdownResult(reply.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: renderShutdown(reply.envelope.result), stderr: "" };
};
