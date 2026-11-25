#!/usr/bin/env node
/**
 * Foreground daemon entry point: select the state root, claim it exclusively, serve the
 * management API, and hold both until SIGINT or SIGTERM. A clean stop closes the socket,
 * releases the lock and exits 0; a held lock or a socket in use exits 1 (PRD §11.6).
 * Once the root is claimed, diagnostics go to `logs/daemon.log` as well as stderr (PRD §15.2).
 * Factory files named on the command line are validated read-only before the root is claimed; an
 * invalid one refuses start with one line and exit 1. Once claimed, the run and each configuration
 * load are recorded in the database and each factory's empty knowledge layout is created.
 */
// First, so it is in place before the store loads `node:sqlite`.
import "./quiet-sqlite-warning.js";
import { readFileSync } from "node:fs";
import type { LoadedFactory, StartedRun } from "./factory-loads.js";
import { claimStateRoot, StateRootLockedError } from "./instance-lock.js";
import { isLogLevel, LOG_LEVELS, openDaemonLog, type DaemonLogger, type LogLevel } from "./log.js";
import { ManagementSocketError, serveManagementApi, type ManagementApi } from "./management-api.js";
import { selectStateRoot } from "@foundry/protocol/state-root";

const EXIT_USAGE = 2;
const EXIT_INSTANCE_FAILURE = 1;

class UsageError extends Error {}

interface Flags {
  home?: string;
  logLevel?: LogLevel;
  factoryFiles: string[];
}

const parseFlags = (args: readonly string[]): Flags => {
  const flags: Flags = { factoryFiles: [] };
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
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      flags.factoryFiles.push(arg);
    }
  }
  return flags;
};

/** This build's version, from the daemon package's manifest beside `dist/`. */
const foundryVersion = (): string =>
  (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

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
  // Loaded dynamically: Node loads the `node:sqlite` builtin while linking static imports, before
  // any module body runs, so only a later import lets the warning filter above take effect.
  const { loadFactoryFiles, startRun } = await import("./factory-loads.js");
  // Read-only and before the claim, so an invalid factory changes nothing in the state root.
  const loaded = loadFactoryFiles(flags.factoryFiles, { env: process.env });
  if (loaded._tag === "Refused") {
    fail(loaded.message);
    return;
  }
  const factories: ReadonlyArray<LoadedFactory> = loaded.factories;

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

  // Installed before serving, so a signal during startup still stops cleanly. `on`, not `once`:
  // a repeated signal is a no-op instead of falling back to Node's default (abrupt) handler.
  let api: ManagementApi | undefined;
  let started: StartedRun | undefined;
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
      .finally(() => started?.close())
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
    started = await startRun({
      stateRoot,
      runId: log.runId,
      startedAt: Date.parse(startedAt),
      version: foundryVersion(),
      factories,
    });
  } catch (error) {
    // A newer schema or an unopenable database is an instance-level failure (PRD §11.6).
    const message = `cannot record the run in ${stateRoot}: ${(error as Error).message}`;
    log.error("run not recorded", { detail: { error: (error as Error).message } });
    log.close();
    claim.release();
    fail(message);
    return;
  }
  for (const factory of factories) {
    const factoryLog = log.with({ factoryId: factory.factoryId });
    for (const warning of factory.warnings) {
      factoryLog.warn("factory configuration warning", { detail: { path: warning.path, warning: warning.message } });
    }
  }
  for (const load of started.loads) {
    log.info("factory configuration loaded", {
      factoryId: load.factoryId,
      detail: { loadId: load.loadId, configHash: load.configHash },
    });
  }

  try {
    api = await serveManagementApi({
      stateRoot,
      status: () => ({ instance: { stateRoot, daemonPid: process.pid, startedAt } }),
    });
  } catch (error) {
    if (error instanceof ManagementSocketError) {
      log.error("management API refused", { detail: { reason: error.reason, socket: error.socketPath } });
    } else {
      log.error("management API failed", { detail: { error: (error as Error).message } });
    }
    await started.close();
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
