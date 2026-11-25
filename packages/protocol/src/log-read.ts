/**
 * Reads the instance's log files and selects lines by reference (PRD §15.2). Used by the daemon to
 * answer `GET /api/v1/logs` and by the CLI itself when no daemon answers, since `foundry logs`
 * works with the daemon down. It reads only files under `logs/` in the state root, never the
 * database (ADR 0001).
 *
 * The file names repeat the writers' (`@foundry/daemon` log.ts, `@foundry/host` log.ts and
 * client.ts); the logs API test checks they agree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchStderr, LogFilter, LogQuery, LogsResult } from "./log-query.js";

const LOGS_DIR = "logs";
const DAEMON_LOG_FILE = "daemon.log";
const HOST_LOG_FILE = "host.log";
const LAUNCHES_DIR = join(LOGS_DIR, "launches");

/** The reference each filter matches in a log line. */
const FILTER_KEYS: Readonly<Record<LogFilter, string>> = {
  factory: "factoryId",
  ticket: "ticketId",
  slot: "slotId",
  launch: "launchId",
};

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const readIfPresent = (path: string): Buffer | undefined => {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
};

/** The daemon log's files, oldest first: rotated copies by descending number, then the live file. */
const daemonLogFiles = (stateRoot: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(join(stateRoot, LOGS_DIR));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const rotated = names
    .map((name) => /^daemon\.log\.([1-9][0-9]*)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a)
    .map((n) => join(stateRoot, LOGS_DIR, `${DAEMON_LOG_FILE}.${n}`));
  return [...rotated, join(stateRoot, LOGS_DIR, DAEMON_LOG_FILE)];
};

const activeFilters = (query: LogQuery): Array<[string, string]> =>
  (Object.keys(FILTER_KEYS) as LogFilter[])
    .filter((filter) => query[filter] !== undefined)
    .map((filter) => [FILTER_KEYS[filter], query[filter]!]);

/** Whether `line` carries every reference asked for. With no filters every line is selected. */
const selects = (line: string, filters: ReadonlyArray<[string, string]>): boolean => {
  if (filters.length === 0) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false; // A line that is not JSON carries no references.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return filters.every(([key, value]) => record[key] === value);
};

/**
 * Decodes a stderr tail as UTF-8. The host keeps the last bytes of stderr, so the tail may start
 * inside a multi-byte character; those leading continuation bytes are dropped rather than shown
 * as replacement characters. Any other invalid bytes become U+FFFD.
 */
export const decodeStderrTail = (bytes: Uint8Array): string => {
  let start = 0;
  while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start));
};

const launchStderr = (stateRoot: string, launchId: string): LaunchStderr | undefined => {
  const path = join(stateRoot, LAUNCHES_DIR, `${launchId}.stderr`);
  const bytes = readIfPresent(path);
  return bytes === undefined ? undefined : { launchId, path, text: decodeStderrTail(bytes) };
};

/**
 * Selects lines from the daemon log (rotated copies included) or, with `host`, the host log.
 * The query must already be valid (`logQueryProblem`). Missing files read as empty.
 */
export const readLogs = (stateRoot: string, query: LogQuery): LogsResult => {
  const files = query.host ? [join(stateRoot, LOGS_DIR, HOST_LOG_FILE)] : daemonLogFiles(stateRoot);
  const filters = activeFilters(query);
  const lines: string[] = [];
  for (const file of files) {
    const text = readIfPresent(file)?.toString("utf8");
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      if (line !== "" && selects(line, filters)) lines.push(line);
    }
  }
  const stderr = query.launch === undefined ? undefined : launchStderr(stateRoot, query.launch);
  return { log: query.host ? "host" : "daemon", lines, ...(stderr === undefined ? {} : { launchStderr: stderr }) };
};
