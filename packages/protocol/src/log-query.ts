/**
 * The log selection contract (PRD §11.1, §15.2): which log `foundry logs` reads and which lines
 * of it, encoded as the query string of `GET /api/v1/logs`. Shared by the daemon, which serves
 * the selection, and the CLI, which reads the same files itself when no daemon answers.
 */
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

/** `GET`: log lines selected by the query below. */
export const LOGS_PATH = `${MANAGEMENT_API_PREFIX}/logs`;

/** What to read. Every filter given must match a line's reference exactly; none means every line. */
export interface LogQuery {
  /** Read `logs/host.log` instead of the daemon log. */
  readonly host: boolean;
  readonly factory?: string | undefined;
  readonly ticket?: string | undefined;
  /** `station/ordinal`. */
  readonly slot?: string | undefined;
  /** Also selects the launch's retained stderr, if any. */
  readonly launch?: string | undefined;
}

export const LOG_FILTERS = ["factory", "ticket", "slot", "launch"] as const;

export type LogFilter = (typeof LOG_FILTERS)[number];

/** Launch IDs name a file under `logs/launches`; anything that could leave that directory is refused. */
export const LAUNCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Why `query` cannot be served, or `undefined` if it can. Wording matches the CLI flags. */
export const logQueryProblem = (query: LogQuery): string | undefined => {
  for (const filter of LOG_FILTERS) {
    if (query[filter] === "") {return `--${filter} needs a value`;}
  }

  if (query.launch !== undefined && !LAUNCH_ID_PATTERN.test(query.launch)) {
    return `--launch ${JSON.stringify(query.launch)} is not a launch ID`;
  }

  return undefined;
};

export const encodeLogQuery = (query: LogQuery): string => {
  const params = new URLSearchParams();

  if (query.host) {params.set("host", "1");}

  for (const filter of LOG_FILTERS) {
    const value = query[filter];

    if (value !== undefined) {params.set(filter, value);}
  }

  return params.toString();
};

/** The query, or the reason it is refused. Unknown, repeated or malformed parameters are refused. */
export const decodeLogQuery = (params: URLSearchParams): LogQuery | string => {
  const query: { host: boolean } & Partial<Record<LogFilter, string>> = { host: false };
  const seen = new Set<string>();

  for (const [key, value] of params) {
    if (seen.has(key)) {return `parameter ${key} is repeated`;}

    seen.add(key);

    if (key === "host") {
      if (value !== "1") {return "parameter host must be 1";}

      query.host = true;
    } else if ((LOG_FILTERS as ReadonlyArray<string>).includes(key)) {
      query[key as LogFilter] = value;
    } else {
      return `unknown parameter ${key}`;
    }
  }

  return logQueryProblem(query) ?? query;
};

/** A launch's retained stderr tail (PRD §15.2). */
export interface LaunchStderr {
  readonly launchId: string;
  readonly path: string;
  readonly text: string;
}

/** Result of `GET /api/v1/logs`. */
export interface LogsResult {
  /** The log the lines come from. */
  readonly log: "daemon" | "host";
  /** Selected lines, oldest first, each exactly as written. */
  readonly lines: ReadonlyArray<string>;
  /** Present when `launch` was given and that launch's stderr was retained. */
  readonly launchStderr?: LaunchStderr;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isLogsResult = (value: unknown): value is LogsResult => {
  if (!isRecord(value)) {return false;}

  if (value["log"] !== "daemon" && value["log"] !== "host") {return false;}

  const lines = value["lines"];

  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {return false;}

  const stderr = value["launchStderr"];

  if (stderr === undefined) {return true;}

  return (
    isRecord(stderr) &&
    typeof stderr["launchId"] === "string" &&
    typeof stderr["path"] === "string" &&
    typeof stderr["text"] === "string"
  );
};
