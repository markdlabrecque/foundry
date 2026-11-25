#!/usr/bin/env node
/**
 * Foreground daemon entry point: select the state root, claim it exclusively, serve the
 * management API, and hold both until SIGINT or SIGTERM. A clean stop closes the socket,
 * releases the lock and exits 0; a held lock or a socket in use exits 1 (PRD §11.6).
 * Once the root is claimed, diagnostics go to `logs/daemon.log` as well as stderr (PRD §15.2).
 * The database (`foundry.db` in the state root) is opened after the log and before serving; it
 * serves operator holds and the event stream. Stop order: API close, store close, log close, lock release.
 * Factory files named on the command line are validated read-only before the root is claimed; an
 * invalid one refuses start with one line and exit 1. Once the store is open, each factory's empty
 * knowledge layout is created, its dedicated clone is created on first start or reused (never
 * fetched) after (PRD §9.1), and the run and each configuration load are recorded in it.
 */
import { readFileSync } from "node:fs";
import { expectDefined, messageOf } from "@foundry/protocol/errors";
import { join } from "node:path";
import { createKnowledgeLayout, LoadFactoriesResult, loadFactoryFiles, recordRun } from "./factory-loads.js";
import type { LoadedFactory, RecordedLoad } from "./factory-loads.js";
import { createTicketService, ticketFactoryFrom } from "./tickets.js";
import { clearCloneStaging, cloneRefusalOf, ensureFactoryClone, recordCloneRefusals } from "./factory-clone.js";
import type { CloneRefusal, EnsuredClone } from "./factory-clone.js";
import { decideFactoryStarts, describeBlocker } from "./start-refusal.js";
import type { StartBlocker, StartDecision } from "./start-refusal.js";
import { Effect, Exit, Schema, Scope } from "effect";
import { storeEventSource } from "./events.js";
import { storeHoldsReader } from "./holds.js";
import { storeFactoriesReader } from "./factories.js";
import { importStoreQuietly } from "./quiet-store.js";
import type { Store } from "./store.js";
import { claimStateRoot, StateRootLockedError } from "./instance-lock.js";
import { isLogLevel, LOG_LEVELS, openDaemonLog } from "./log.js";
import type { DaemonLogger, LogLevel } from "./log.js";
import { ManagementSocketError, serveManagementApi } from "./management-api.js";
import type { ManagementApi } from "./management-api.js";
import { selectStateRoot } from "@foundry/protocol/state-root";

const EXIT_USAGE = 2;
const EXIT_INSTANCE_FAILURE = 1;
const DATABASE_FILE_NAME = "foundry.db";

class UsageError extends Error {}

interface Flags {
  home?: string;
  logLevel?: LogLevel;
  factoryFiles: Array<string>;
}

const parseFlags = (args: ReadonlyArray<string>): Flags => {
  const flags: Flags = { factoryFiles: [] };

  const value = (name: string, arg: string, i: number): [string, number] => {
    const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
    const given = inline ?? args[i + 1];

    if (given === undefined || given === "") {throw new UsageError(`${name} needs a value`);}

    return [given, inline === undefined ? i + 1 : i];
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === undefined) {break;}

    if (arg === "--home" || arg.startsWith("--home=")) {
      [flags.home, i] = value("--home", arg, i);
    } else if (arg === "--log-level" || arg.startsWith("--log-level=")) {
      let level: string;
      [level, i] = value("--log-level", arg, i);

      if (!isLogLevel(level)) {throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);}

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
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })));

const foundryVersion = (): string => decodeManifest(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const fail = (message: string): never => {
  process.stderr.write(`foundry daemon: ${message}\n`);
  process.exit(EXIT_INSTANCE_FAILURE);
};

const main = async (): Promise<void> => {
  let flags: Flags;

  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`foundry daemon: ${messageOf(error)}\n`);
    process.exit(EXIT_USAGE);
  }

  // Read-only and before the claim, so an invalid factory changes nothing in the state root.
  const loaded = loadFactoryFiles(flags.factoryFiles, { env: process.env });

  if (LoadFactoriesResult.$is("Refused")(loaded)) {
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
    fail(error instanceof StateRootLockedError ? error.message : `cannot claim state root ${stateRoot}: ${messageOf(error)}`);

    return;
  }

  process.on("exit", () => claim.release());

  let log: DaemonLogger;

  try {
    log = openDaemonLog(flags.logLevel === undefined ? { stateRoot } : { stateRoot, level: flags.logLevel });
  } catch (error) {
    claim.release();
    fail(`cannot open the daemon log in ${stateRoot}: ${messageOf(error)}`);

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
    log.error("database open failed", { detail: { file: databaseFile, error: messageOf(error) } });
    await closeStore();
    log.close();
    claim.release();
    fail(`cannot open the database: ${messageOf(error)}`);

    return;
  }

  const startedAt = new Date().toISOString();

  // Staging left by a daemon that died mid-clone; safe to remove under the claim, before any clone starts.
  try {
    for (const leftover of clearCloneStaging(stateRoot)) {log.info("clone staging removed", { detail: { path: leftover } });}
  } catch (error) {
    log.warn("clone staging not removed", { detail: { error: messageOf(error) } });
  }

  // The dedicated clone of each factory (PRD §9.1): created once, then reused without contacting the
  // source. A clone that fails refuses that factory alone (§11.6), recorded once the run is.
  const clones = new Map<string, EnsuredClone>();
  const cloneRefusals: Array<CloneRefusal> = [];

  for (const factory of factories) {
    try {
      const clone = await ensureFactoryClone(factory, { stateRoot });
      clones.set(factory.factoryId, clone);
      log.info(clone.created ? "factory clone created" : "factory clone reused", {
        factoryId: factory.factoryId,
        detail: { path: clone.path, source: clone.source },
      });

      if (clone.source !== clone.configuredSource) {
        log.warn("factory clone source differs from configuration", {
          factoryId: factory.factoryId,
          detail: { path: clone.path, clonedFrom: clone.source, configured: clone.configuredSource },
        });
      }
    } catch (error) {
      cloneRefusals.push(cloneRefusalOf(stateRoot, factory.factoryId, error));
    }
  }

  let loads: ReadonlyArray<RecordedLoad>;

  try {
    // The reserved, empty knowledge layout (PRD §5.4.3); existing directories are left alone.
    for (const factory of factories) {createKnowledgeLayout(factory);}

    loads = await Effect.runPromise(
      recordRun(store, { runId: log.runId, startedAt: Date.parse(startedAt), version: foundryVersion(), factories }),
    );
  } catch (error) {
    log.error("run not recorded", { detail: { error: messageOf(error) } });
    await closeStore();
    log.close();
    claim.release();
    fail(`cannot record the run in ${stateRoot}: ${messageOf(error)}`);

    return;
  }

  for (const factory of factories) {
    const factoryLog = log.with({ factoryId: factory.factoryId });

    for (const warning of factory.warnings) {
      factoryLog.warn("factory configuration warning", { detail: { path: warning.path, warning: warning.message } });
    }
  }

  for (const load of loads) {
    log.info("factory configuration loaded", {
      factoryId: load.factoryId,
      detail: { loadId: load.loadId, configHash: load.configHash },
    });
  }

  // A factory whose open records name removed configuration, or whose clone failed, is refused
  // alone (PRD §4, §11.6): the daemon keeps running and the other factories start.
  const cloneRefused = new Set(cloneRefusals.map((r) => r.factoryId));
  let decision: StartDecision;

  try {
    await Effect.runPromise(
      recordCloneRefusals(
        store,
        cloneRefusals.map((r) => {
          const loadId = loads.find((l) => l.factoryId === r.factoryId)?.loadId;

          return loadId === undefined ? r : { ...r, loadId };
        }),
      ),
    );
    decision = await Effect.runPromise(
      decideFactoryStarts(
        store,
        loads.filter((l) => !cloneRefused.has(l.factoryId)).map((l) => ({ factoryId: l.factoryId, loadId: l.loadId, config: expectDefined(factories.find((f) => f.factoryId === l.factoryId), `factory ${l.factoryId}`).config })),
      ),
    );
  } catch (error) {
    log.error("factory start checks failed", { detail: { error: messageOf(error) } });
    await closeStore();
    log.close();
    claim.release();
    fail(`cannot check open records in ${stateRoot}: ${messageOf(error)}`);

    return;
  }

  for (const refused of cloneRefusals) {
    log.warn("factory start refused", {
      factoryId: refused.factoryId,
      detail: { reason: refused.reason, clonePath: refused.clonePath, error: refused.message },
    });
  }

  for (const refused of decision.refused) {
    log.warn("factory start refused", {
      factoryId: refused.factoryId,
      detail: { blockers: refused.blockers.length, first: describeBlocker(expectDefined(refused.blockers[0], "a blocker on a refused factory")) },
    });
  }

  // Configuration is read only at start (PRD §4), so the started set is fixed for this run.
  // Ticket commands naming a refused factory get `unknown_factory` ("not loaded") for now; a
  // distinct refused error belongs with showing refusals in status.
  const ticketFactories = factories.flatMap((f) =>
    decision.started.includes(f.factoryId) ? [ticketFactoryFrom(f.config)] : [],
  );

  // Each factory's transitions carry this run's recorded configuration load.
  const loadIds = new Map(loads.map((l) => [l.factoryId, String(l.loadId)]));

  // This run's refusals and their blockers, held in daemon state so status and the factory list
  // can show them without reading history. Recomputed on every start.
  const refusedFactories = new Map<string, { readonly blockers: ReadonlyArray<StartBlocker> } | { readonly clone: CloneRefusal }>([
    ...cloneRefusals.map((r) => [r.factoryId, { clone: r }] as const),
    ...decision.refused.map((r) => [r.factoryId, { blockers: r.blockers }] as const),
  ]);

  void refusedFactories;

  // Installed before serving, so a signal during startup still stops cleanly. `on`, not `once`:
  // a repeated signal is a no-op instead of falling back to Node's default (abrupt) handler.
  let api: ManagementApi | undefined;
  let stopping = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {return;}

    stopping = true;
    log.info("daemon stopping", { detail: { signal } });

    // Before the API is up, the code after `serveManagementApi` sees `stopping` and finishes the stop.
    if (api !== undefined) {finish(api);}
  };

  const finish = (served: ManagementApi): void => {
    // The store closes even if the API close fails, and the process exits even if the store close fails.
    void (async () => {
      try {
        try {
          await served.close();
        } finally {
          await closeStore();
        }
      } finally {
        log.close();
        claim.release();
        process.exit(0);
      }
    })();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    api = await serveManagementApi({
      stateRoot,
      status: () => ({ instance: { stateRoot, daemonPid: process.pid, startedAt } }),
      holds: storeHoldsReader(store),
      tickets: createTicketService({
        stateRoot,
        store,
        factories: () => ticketFactories,
        configLoad: (factory) => loadIds.get(factory),
      }),
      events: storeEventSource(store),
      clonePath: (factory) => clones.get(factory)?.path,
      // Read from the recorded run and its configuration loads, not from memory.
      factories: storeFactoriesReader(store, log.runId),
    });
  } catch (error) {
    if (error instanceof ManagementSocketError) {
      log.error("management API refused", { detail: { reason: error.reason, socket: error.socketPath } });
    } else {
      log.error("management API failed", { detail: { error: messageOf(error) } });
    }

    await closeStore();
    log.close();
    claim.release();
    fail(error instanceof ManagementSocketError ? error.message : `cannot serve the management API: ${messageOf(error)}`);

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
