#!/usr/bin/env node
/**
 * Foreground daemon entry point: select the state root, claim it exclusively, serve the
 * management API, and hold both until SIGINT or SIGTERM. A clean stop closes the socket,
 * releases the lock and exits 0; a held lock or a socket in use exits 1 (PRD §11.6).
 * Once the root is claimed, diagnostics go to `logs/daemon.log` as well as stderr (PRD §15.2).
 * The database (`foundry.db` in the state root) is opened after the log and before serving; it
 * serves operator holds and the event stream. Stop order: API close, store close, log close, lock release.
 * Factory loading arrives in later tickets.
 */
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { storeEventSource } from "./events.js";
import { storeHoldsReader } from "./holds.js";
import { importStoreQuietly } from "./quiet-store.js";
import type { Store } from "./store.js";
import { claimStateRoot, StateRootLockedError } from "./instance-lock.js";
import { isLogLevel, LOG_LEVELS, openDaemonLog, type DaemonLogger, type LogLevel } from "./log.js";
import { ManagementSocketError, serveManagementApi, type ManagementApi } from "./management-api.js";
import { selectStateRoot } from "@foundry/protocol/state-root";

const EXIT_USAGE = 2;
const EXIT_INSTANCE_FAILURE = 1;
const DATABASE_FILE_NAME = "foundry.db";

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

const fail = (message: string): never => {
  process.stderr.write(`foundry daemon: ${message}\n`);
  process.exit(EXIT_INSTANCE_FAILURE);
};

const main = async (): Promise<void> => {
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
    fail(error instanceof StateRootLockedError ? error.message : `cannot claim state root ${stateRoot}: ${(error as Error).message}`);
    return;
  }
  process.on("exit", () => claim.release());

  let log: DaemonLogger;
  try {
    log = openDaemonLog({ stateRoot, ...(flags.logLevel === undefined ? {} : { level: flags.logLevel }) });
  } catch (error) {
    claim.release();
    fail(`cannot open the daemon log in ${stateRoot}: ${(error as Error).message}`);
    return;
  }

  // One store for the daemon's lifetime, closed with its scope.
  const storeScope = Effect.runSync(Scope.make());
  const closeStore = (): Promise<void> => Effect.runPromise(Scope.close(storeScope, Exit.void));
  const databaseFile = join(stateRoot, DATABASE_FILE_NAME);
  let store: Store;
  try {
    const { openStore } = await importStoreQuietly();
    store = await Effect.runPromise(Scope.provide(storeScope)(openStore({ filename: databaseFile })));
  } catch (error) {
    log.error("database open failed", { detail: { file: databaseFile, error: (error as Error).message } });
    await closeStore();
    log.close();
    claim.release();
    fail(`cannot open the database: ${(error as Error).message}`);
    return;
  }

  // Installed before serving, so a signal during startup still stops cleanly. `on`, not `once`:
  // a repeated signal is a no-op instead of falling back to Node's default (abrupt) handler.
  let api: ManagementApi | undefined;
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info("daemon stopping", { detail: { signal } });
    // Before the API is up, the code after `serveManagementApi` sees `stopping` and finishes the stop.
    if (api !== undefined) finish(api);
  };
  const finish = (served: ManagementApi): void => {
    void served
      .close()
      .finally(closeStore)
      .finally(() => {
        log.close();
        claim.release();
        process.exit(0);
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const startedAt = new Date().toISOString();
  try {
    api = await serveManagementApi({
      stateRoot,
      status: () => ({ instance: { stateRoot, daemonPid: process.pid, startedAt } }),
      holds: storeHoldsReader(store),
      events: storeEventSource(store),
    });
  } catch (error) {
    if (error instanceof ManagementSocketError) {
      log.error("management API refused", { detail: { reason: error.reason, socket: error.socketPath } });
    } else {
      log.error("management API failed", { detail: { error: (error as Error).message } });
    }
    await closeStore();
    log.close();
    claim.release();
    fail(error instanceof ManagementSocketError ? error.message : `cannot serve the management API: ${(error as Error).message}`);
    return;
  }

  // The listening socket keeps the foreground process alive until asked to stop.
  if (stopping) {
    finish(api);
    return;
  }
  log.info("daemon started", {
    detail: { pid: process.pid, stateRoot, socket: api.socketPath, logLevel: log.level },
  });
  process.stdout.write(`foundry daemon: state root ${stateRoot} claimed (pid ${process.pid})\n`);
  process.stdout.write(`foundry daemon: management API on ${api.socketPath}\n`);
};

await main();
