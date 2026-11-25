/**
 * The daemon's structured log (PRD §15.2): `logs/daemon.log` in the state root, one JSON object per
 * line, written as well as stderr. The event stream records what Foundry decided; this log records
 * why Foundry itself misbehaved.
 *
 * Every line carries the daemon run ID and, where they apply, the factory, slot, launch, ticket,
 * message and operation IDs, so a line joins to the history. Free-form detail is limited to scalar
 * values, and keys that look like credentials or message bodies are never written.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Path, relative to the state root, of the daemon log. Rotated copies add `.1`, `.2`, ... */
export const DAEMON_LOG_NAME = join("logs", "daemon.log");

export const daemonLogPath = (stateRoot: string): string => join(stateRoot, DAEMON_LOG_NAME);

/** Rotation defaults: the live file plus four rotated copies of at most 10 MiB each. */
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_KEEP_FILES = 5;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const isLogLevel = (value: string): value is LogLevel => (LOG_LEVELS as readonly string[]).includes(value);

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

/** The record identifiers a line may carry so it joins to the event history. */
export interface LogRefs {
  readonly factoryId?: string;
  readonly slotId?: string;
  readonly launchId?: string;
  readonly ticketId?: string;
  readonly messageId?: string;
  readonly operationId?: string;
}

const REF_KEYS = ["factoryId", "slotId", "launchId", "ticketId", "messageId", "operationId"] as const;

export type LogDetailValue = string | number | boolean | null;

export interface LogEntry extends LogRefs {
  /** Scalar diagnostics. Credential-like keys are redacted and body-like keys omitted. */
  readonly detail?: Readonly<Record<string, LogDetailValue>>;
}

/** Keys whose values are never written: credentials. */
const CREDENTIAL_KEY = /pass(word|phrase)?|secret|token|credential|auth|api[-_]?key|private[-_]?key|cookie/i;
/** Keys whose values are never written: routine message and prompt content. */
const BODY_KEY = /^(body|text|content|prompt|message|messageBody)$/i;

export const REDACTED = "[redacted]";
export const OMITTED = "[omitted]";

const sanitizeDetail = (detail: Readonly<Record<string, LogDetailValue>>): Record<string, LogDetailValue> => {
  const clean: Record<string, LogDetailValue> = {};
  for (const [key, value] of Object.entries(detail)) {
    clean[key] = CREDENTIAL_KEY.test(key) ? REDACTED : BODY_KEY.test(key) ? OMITTED : value;
  }
  return clean;
};

export interface DaemonLogger {
  readonly runId: string;
  readonly level: LogLevel;
  readonly path: string;
  debug(msg: string, entry?: LogEntry): void;
  info(msg: string, entry?: LogEntry): void;
  warn(msg: string, entry?: LogEntry): void;
  error(msg: string, entry?: LogEntry): void;
  /** A logger that adds `refs` to every line; it shares this logger's file. */
  with(refs: LogRefs): DaemonLogger;
  /** Closes the file. Later lines go to stderr only. */
  close(): void;
}

export interface DaemonLoggerOptions {
  readonly stateRoot: string;
  /** Default: a fresh UUID. */
  readonly runId?: string;
  /** Default `info`. */
  readonly level?: LogLevel;
  readonly maxBytes?: number;
  /** Files kept in total, the live one included. Default 5. */
  readonly keepFiles?: number;
  /** Receives each line as well as the file. Default: process stderr. */
  readonly stderr?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Opens the daemon log for appending (0700 directory, 0600 file). Callers must hold the state-root
 * lock, so only one daemon writes and rotates the file.
 */
export const openDaemonLog = (options: DaemonLoggerOptions): DaemonLogger => {
  const path = daemonLogPath(options.stateRoot);
  const runId = options.runId ?? randomUUID();
  const level = options.level ?? "info";
  const maxBytes = options.maxBytes ?? DAEMON_LOG_MAX_BYTES;
  const keepFiles = Math.max(1, options.keepFiles ?? DAEMON_LOG_KEEP_FILES);
  const toStderr = options.stderr ?? ((line: string) => void process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const openFile = (): { fd: number; size: number } => {
    const dir = join(options.stateRoot, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The mode above applies only on creation; an older directory is tightened too.
    chmodSync(dir, 0o700);
    const fd = openSync(path, "a", 0o600);
    // The mode above applies only on creation; an older file is tightened too.
    fchmodSync(fd, 0o600);
    return { fd, size: fstatSync(fd).size };
  };
  const failure = (msg: string, error: unknown): string =>
    `${JSON.stringify({ time: now().toISOString(), level: "error", runId, msg, detail: { error: (error as Error).message } })}\n`;

  // A log file that cannot be opened is not fatal: the daemon logs to stderr only.
  let file: { fd: number; size: number } | undefined;
  try {
    file = openFile();
  } catch (error) {
    toStderr(failure("daemon log unavailable; logging to stderr only", error));
  }

  const rotate = (): void => {
    if (file === undefined) return;
    closeSync(file.fd);
    file = undefined;
    if (keepFiles === 1) {
      unlinkSync(path);
    } else {
      for (let i = keepFiles - 1; i >= 1; i--) {
        const from = i === 1 ? path : `${path}.${i - 1}`;
        try {
          renameSync(from, `${path}.${i}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    file = openFile();
  };

  const write = (line: string): void => {
    toStderr(line);
    if (file === undefined) return;
    try {
      const bytes = Buffer.from(line, "utf8");
      if (file.size > 0 && file.size + bytes.length > maxBytes) rotate();
      if (file === undefined) return;
      writeSync(file.fd, bytes);
      file.size += bytes.length;
    } catch (error) {
      // A failing log file must not take the daemon down; stderr still has every line.
      toStderr(failure("daemon log write failed", error));
    }
  };

  const make = (bound: LogRefs): DaemonLogger => {
    const emit = (lineLevel: LogLevel, msg: string, entry: LogEntry = {}): void => {
      if (rank(lineLevel) < rank(level)) return;
      const line: Record<string, unknown> = { time: now().toISOString(), level: lineLevel, runId, msg };
      for (const key of REF_KEYS) {
        const value = entry[key] ?? bound[key];
        if (value !== undefined) line[key] = value;
      }
      if (entry.detail !== undefined) line["detail"] = sanitizeDetail(entry.detail);
      write(`${JSON.stringify(line)}\n`);
    };
    return {
      runId,
      level,
      path,
      debug: (msg, entry) => emit("debug", msg, entry),
      info: (msg, entry) => emit("info", msg, entry),
      warn: (msg, entry) => emit("warn", msg, entry),
      error: (msg, entry) => emit("error", msg, entry),
      with: (refs) => make({ ...bound, ...refs }),
      close: () => {
        if (file === undefined) return;
        closeSync(file.fd);
        file = undefined;
      },
    };
  };
  return make({});
};
