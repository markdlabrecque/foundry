/**
 * `foundry factory stop <name> [--force]` (PRD §10.3, §11.1): one `POST` over the management
 * socket. The daemon answers only once every owned process group of the factory is confirmed gone,
 * or once it has failed to confirm one; the latter is a refusal (exit 1), never success.
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import { factoryStopPath, isFactoryStopResult } from "@foundry/protocol/factories-api";
import type { FactoryStopRequest, FactoryStopResult } from "@foundry/protocol/factories-api";
import { DaemonUnreachableError, postToDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

/**
 * How long the CLI waits for the daemon's answer. A graceful stop may take the drain wait, the
 * SIGTERM grace period and the post-SIGKILL wait, so this is well above their defaults.
 */
const STOP_TIMEOUT_MS = 60_000;

export interface FactoryStopOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  /** Skip the drain and the grace period. */
  readonly force: boolean;
}

export type FactoryStopOutcome = StatusOutcome;

const refused = (message: string): FactoryStopOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

const renderStop = (result: FactoryStopResult): string => {
  const lines = [`factory ${result.factoryId} stopped${result.force ? " (forced)" : ""}`];

  for (const launch of result.launches) {
    const how = launch.escalated ? "killed" : launch.drained ? "drained, terminated" : "terminated";
    lines.push(`  ${launch.slotId}  ${launch.launchId}  ${how}`);
  }

  return `${lines.join("\n")}\n`;
};

/** `foundry factory stop <name>`: stops the named factory's workers and leaves the others alone. */
export const runFactoryStop = async (options: FactoryStopOptions): Promise<FactoryStopOutcome> => {
  if (options.home === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };}

  if (options.name === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: factory name must not be empty\n" };}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  const body: FactoryStopRequest = { force: options.force };
  let reply;

  try {
    reply = await postToDaemon(stateRoot, factoryStopPath(options.name), body, { timeoutMs: STOP_TIMEOUT_MS });
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

  if (!isFactoryStopResult(reply.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: renderStop(reply.envelope.result), stderr: "" };
};
