/**
 * `foundry factory path <name>` (PRD §9.1, §11.1): one `GET` over the management socket, printing
 * the factory's dedicated clone path. The CLI never opens the database (ADR 0001).
 */
import { Schema } from "effect";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import { factoryPathPath, isFactoryPathResult } from "@foundry/protocol/factory-path";
import { factorySyncPath, isFactorySyncResult } from "@foundry/protocol/factory-sync";
import type { FactorySyncResult } from "@foundry/protocol/factory-sync";
import { DaemonUnreachableError, getFromDaemon, postToDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

export interface FactoryPathOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
}

export type FactoryOutcome = StatusOutcome;

const refused = (message: string): FactoryOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

/** `foundry factory path <name>`: the clone path, one line, for use as a Git remote. */
export const runFactoryPath = async (options: FactoryPathOptions): Promise<FactoryOutcome> => {
  if (options.home === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };}

  if (options.name === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: factory name must not be empty\n" };}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await getFromDaemon(stateRoot, factoryPathPath(options.name));
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

  if (!isFactoryPathResult(reply.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: `${reply.envelope.result.path}\n`, stderr: "" };
};

export interface FactorySyncOptions extends FactoryPathOptions {
  /** Block until the sync has finished. */
  readonly wait: boolean;
}

const isText = Schema.is(Schema.String);

/** How long `--wait` waits for a fetch and merge before giving up on the answer. */
const SYNC_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

const headOf = (detail: FactorySyncResult["operation"]["result"], key: string): string => {
  const value = detail?.[key];

  return isText(value) ? value : "?";
};

const renderSync = ({ factory, operation }: FactorySyncResult): string => {
  if (operation.status === "queued") {return `sync of ${factory} queued as operation ${operation.id}\n`;}

  if (operation.status === "complete") {
    return `sync of ${factory} complete (operation ${operation.id}): ${headOf(operation.result, "previousHead")} -> ${headOf(operation.result, "head")}\n`;
  }

  return `sync of ${factory} ${operation.status} (operation ${operation.id})\n`;
};

/**
 * `foundry factory sync <name> [--wait]`: queues a sync of the factory's clone from its source and
 * prints the operation ID; with `--wait`, waits for it and exits 1 unless it completed.
 */
export const runFactorySync = async (options: FactorySyncOptions): Promise<FactoryOutcome> => {
  if (options.home === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };}

  if (options.name === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: factory name must not be empty\n" };}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await postToDaemon(
      stateRoot,
      factorySyncPath(options.name, options.wait),
      {},
      options.wait ? { timeoutMs: SYNC_WAIT_TIMEOUT_MS } : {},
    );
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }

    return refused(messageOf(error));
  }

  const result = reply.envelope.ok ? reply.envelope.result : undefined;
  const finishedBadly = options.wait && isFactorySyncResult(result) && result.operation.status !== "complete";

  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;

    return { exitCode: reply.envelope.ok && !finishedBadly ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }

  if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

  if (!isFactorySyncResult(result)) {return refused("the daemon answered with an unexpected shape");}

  if (finishedBadly) {
    const reason = result.operation.result?.["reason"];

    return {
      exitCode: EXIT_REFUSED,
      stdout: renderSync(result),
      stderr: isText(reason) ? `foundry: ${reason}\n` : "",
    };
  }

  return { exitCode: EXIT_OK, stdout: renderSync(result), stderr: "" };
};
