/**
 * The `foundry` command line (PRD §11). This ticket serves `foundry status`; later tickets add
 * commands. Exit codes follow PRD §11.5.
 */
// The state-root rule only: the CLI never loads the daemon itself (ADR 0001).
import { selectStateRoot } from "@foundry/daemon/state-root";
import { isStatusResult, STATUS_PATH, type StatusResult } from "@foundry/protocol/management-api";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREACHABLE = 3;

/** The process surroundings, injected so the CLI runs in-process in tests. */
export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

class UsageError extends Error {}

interface Parsed {
  readonly words: readonly string[];
  readonly json: boolean;
  readonly home: string | undefined;
}

const parse = (args: readonly string[]): Parsed => {
  const words: string[] = [];
  let json = false;
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--home") {
      const value = args[++i];
      if (value === undefined || value === "") throw new UsageError("--home needs a directory");
      home = value;
    } else if (arg.startsWith("--home=")) {
      home = arg.slice("--home=".length);
      if (home === "") throw new UsageError("--home needs a directory");
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else words.push(arg);
  }
  return { words, json, home };
};

const renderStatus = ({ instance }: StatusResult): string =>
  [
    `state root  ${instance.stateRoot}`,
    `daemon pid  ${instance.daemonPid}`,
    `started at  ${instance.startedAt}`,
  ].join("\n") + "\n";

/** Runs one CLI invocation and returns its exit code. */
export const runCli = async (args: readonly string[], io: CliIo): Promise<number> => {
  let parsed: Parsed;
  try {
    parsed = parse(args);
    if (parsed.words.length !== 1 || parsed.words[0] !== "status") {
      throw new UsageError(`unknown command${parsed.words.length ? ` "${parsed.words.join(" ")}"` : ""}; usage: foundry status [--json] [--home <dir>]`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`foundry: ${error.message}\n`);
    return EXIT_USAGE;
  }

  const stateRoot = selectStateRoot({ home: parsed.home, env: io.env });
  let reply;
  try {
    reply = await getFromDaemon(stateRoot, STATUS_PATH);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      io.stderr(`foundry: daemon unreachable: ${error.message}\n`);
      return EXIT_UNREACHABLE;
    }
    io.stderr(`foundry: ${(error as Error).message}\n`);
    return EXIT_REFUSED;
  }

  if (parsed.json) {
    io.stdout(reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`);
    return reply.envelope.ok ? EXIT_OK : EXIT_REFUSED;
  }
  if (!reply.envelope.ok) {
    io.stderr(`foundry: ${reply.envelope.error.message}\n`);
    return EXIT_REFUSED;
  }
  if (!isStatusResult(reply.envelope.result)) {
    io.stderr("foundry: the daemon answered status with an unexpected shape\n");
    return EXIT_REFUSED;
  }
  io.stdout(renderStatus(reply.envelope.result));
  return EXIT_OK;
};
