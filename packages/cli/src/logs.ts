/**
 * `foundry logs` (PRD §11.1, §15.2): selected lines of the daemon log, or with `--host` the
 * Worker Host log, plus a launch's retained stderr when `--launch` names one. It asks the daemon
 * (`GET /api/v1/logs`) and, because logs must work with the daemon down, reads the same files
 * itself when no daemon answers. It never opens the database (ADR 0001).
 */
import { encodeLogQuery, isLogsResult, logQueryProblem, LOGS_PATH, type LogQuery, type LogsResult } from "@foundry/protocol/log-query";
import { readLogs } from "@foundry/protocol/log-read";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, type StatusOutcome } from "./status.js";

export interface LogsOptions extends LogQuery {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type LogsOutcome = StatusOutcome;

const render = (result: LogsResult): string => {
  let out = result.lines.map((line) => `${line}\n`).join("");
  if (result.launchStderr !== undefined) {
    const { path, text } = result.launchStderr;
    out += `--- retained stderr ${path}\n${text}${text === "" || text.endsWith("\n") ? "" : "\n"}`;
  }
  return out;
};

const print = (result: LogsResult, json: boolean): LogsOutcome => ({
  exitCode: EXIT_OK,
  stdout: json ? `${JSON.stringify({ ok: true, result })}\n` : render(result),
  stderr: "",
});

const refused = (message: string): LogsOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

export const runLogs = async (options: LogsOptions): Promise<LogsOutcome> => {
  if (options.home === "") return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };
  const query: LogQuery = {
    host: options.host,
    factory: options.factory,
    ticket: options.ticket,
    slot: options.slot,
    launch: options.launch,
  };
  const problem = logQueryProblem(query);
  if (problem !== undefined) return { exitCode: EXIT_USAGE, stdout: "", stderr: `foundry: ${problem}\n` };
  const stateRoot = selectStateRoot({ home: options.home, env: options.env });

  let reply;
  try {
    const search = encodeLogQuery(query);
    reply = await getFromDaemon(stateRoot, search === "" ? LOGS_PATH : `${LOGS_PATH}?${search}`);
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) return refused((error as Error).message);
    // No daemon: the files are read directly, as the daemon would (PRD §15.2).
    try {
      return print(readLogs(stateRoot, query), options.json);
    } catch (readError) {
      return refused(`cannot read logs: ${(readError as Error).message}`);
    }
  }

  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;
    return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }
  if (!reply.envelope.ok) return refused(reply.envelope.error.message);
  if (!isLogsResult(reply.envelope.result)) return refused("the daemon answered logs with an unexpected shape");
  return print(reply.envelope.result, false);
};
