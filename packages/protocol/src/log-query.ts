/**
 * The log selection contract (PRD §11.1, §15.2): which log `foundry logs` reads and which lines
 * of it, encoded as the query string of `GET /api/v1/logs`. Shared by the daemon, which serves
 * the selection, and the CLI, which reads the same files itself when no daemon answers.
 */
import { Schema } from "effect";

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

export const LogFilter = Schema.Literals(LOG_FILTERS);

export type LogFilter = typeof LogFilter.Type;

const isLogFilter = Schema.is(LogFilter);

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
    } else if (isLogFilter(key)) {
      query[key] = value;
    } else {
      return `unknown parameter ${key}`;
    }
  }

  return logQueryProblem(query) ?? query;
};

/** A launch's retained stderr tail (PRD §15.2). */
export const LaunchStderr = Schema.Struct({
  launchId: Schema.String,
  path: Schema.String,
  text: Schema.String,
});

export type LaunchStderr = typeof LaunchStderr.Type;

/** Result of `GET /api/v1/logs`. */
export const LogsResult = Schema.Struct({
  /** The log the lines come from. */
  log: Schema.Literals(["daemon", "host"]),
  /** Selected lines, oldest first, each exactly as written. */
  lines: Schema.Array(Schema.String),
  /** Present when `launch` was given and that launch's stderr was retained. */
  launchStderr: Schema.optionalKey(LaunchStderr),
});

export type LogsResult = typeof LogsResult.Type;

export const isLogsResult = Schema.is(LogsResult);
