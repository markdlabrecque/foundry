#!/usr/bin/env node
/**
 * Foreground daemon entry point: select the state root, claim it exclusively, and hold it until
 * SIGINT or SIGTERM. A clean stop releases the lock and exits 0; a held lock exits 1 (PRD §11.6).
 * Once the root is claimed, diagnostics go to `logs/daemon.log` as well as stderr (PRD §15.2).
 * Factory loading, the database and the management socket arrive in later tickets.
 */
import { claimStateRoot, StateRootLockedError } from "./instance-lock.js";
import { isLogLevel, LOG_LEVELS, openDaemonLog, type LogLevel } from "./log.js";
import { selectStateRoot } from "./state-root.js";

const EXIT_USAGE = 2;
const EXIT_INSTANCE_FAILURE = 1;

class UsageError extends Error {}

interface Flags {
  home?: string;
  logLevel?: LogLevel;
}

const parseFlags = (args: readonly string[]): Flags => {
  const flags: Flags = {};
  const value = (name: string, arg: string, i: number): [string, number] => {
    const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
    const given = inline ?? args[i + 1];
    if (given === undefined || given === "") throw new UsageError(`${name} needs a value`);
    return [given, inline === undefined ? i + 1 : i];
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--home" || arg.startsWith("--home=")) {
      [flags.home, i] = value("--home", arg, i);
    } else if (arg === "--log-level" || arg.startsWith("--log-level=")) {
      let level: string;
      [level, i] = value("--log-level", arg, i);
      if (!isLogLevel(level)) throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);
      flags.logLevel = level;
    }
    // Other arguments (factory files) are left for later tickets.
  }
  return flags;
};

const main = (): void => {
  let flags: Flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`foundry daemon: ${(error as Error).message}\n`);
    process.exit(EXIT_USAGE);
  }
  const stateRoot = selectStateRoot({ home: flags.home, env: process.env });
  let claim;
  try {
    claim = claimStateRoot(stateRoot);
  } catch (error) {
    // A held lock, or a root we cannot create or write (EACCES and the like), is an instance-level
    // failure: one line and exit 1, not a stack trace. Without the lock this daemon must not
    // write the daemon log, which belongs to the daemon that holds it.
    const message = error instanceof StateRootLockedError ? error.message : `cannot claim state root ${stateRoot}: ${(error as Error).message}`;
    process.stderr.write(`foundry daemon: ${message}\n`);
    process.exit(EXIT_INSTANCE_FAILURE);
  }
  const log = openDaemonLog({ stateRoot, ...(flags.logLevel === undefined ? {} : { level: flags.logLevel }) });
  log.info("daemon started", { detail: { pid: process.pid, stateRoot, logLevel: log.level } });
  process.on("exit", () => claim.release());
  // Keep the foreground process alive until asked to stop.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const stop = (signal: NodeJS.Signals): void => {
    clearInterval(keepAlive);
    log.info("daemon stopping", { detail: { signal } });
    log.close();
    claim.release();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`foundry daemon: state root ${stateRoot} claimed (pid ${process.pid})\n`);
};

main();
