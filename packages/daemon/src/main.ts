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
import { codeOf, expectDefined, messageOf } from "@foundry/protocol/errors";
import { join } from "node:path";
import { createKnowledgeLayout, LoadFactoriesResult, loadFactoryFiles, recordRun } from "./factory-loads.js";
import type { LoadedFactory, RecordedLoad } from "./factory-loads.js";
import { createTicketService, ticketFactoryFrom } from "./tickets.js";
import { createOperatorMessages } from "./operator-message.js";
import { clearCloneStaging, cloneRefusalOf, ensureFactoryClone, recordCloneRefusals } from "./factory-clone.js";
import type { CloneRefusal, EnsuredClone } from "./factory-clone.js";
import { createFactorySyncer } from "./factory-sync.js";
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
import type { DaemonLogger, LogLevel, LogRefs } from "./log.js";
import { ManagementSocketError, serveManagementApi } from "./management-api.js";
import type { ManagementApi } from "./management-api.js";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { AGENT_DISCOVER, AGENT_MESSAGE, AGENT_STATUS, channelSocketPath } from "@foundry/protocol";
import { fileURLToPath } from "node:url";
import { connectHost, resolvePiExecutable } from "@foundry/host";
import type { HostConnection } from "@foundry/host";
import { connectOrStartHost, createSlotScheduler, planSlots, recordedCurrentLaunch, storedConversation, storeSlotsReader } from "./slots.js";
import { startChannelServer } from "./channel/server.js";
import type { ChannelServer } from "./channel/server.js";
import { createHostSlotClaim } from "./channel/slot-claim.js";
import { channelLogEvents } from "./channel/log-events.js";
import type { SlotScheduler } from "./slots.js";
import { createFactoryStates, createFactoryStopper } from "./factory-stop.js";
import type { FactoryStopperOptions } from "./factory-stop.js";
import { createSlotFreezer, storeSlotControl } from "./freeze.js";
import type { FreezeChecks, SlotFreezer } from "./freeze.js";
import { instructionFilesCheck, plannedPrimeRequests } from "./instruction-freeze.js";
import { createInstanceShutdown } from "./shutdown.js";
import type { ShutdownHost } from "./shutdown.js";
import { createToolSetGuard, createToolSetRecheck, expectedToolSet, frozenConversation } from "./tool-set-check.js";
import { createSubmissions } from "./submissions.js";
import { agentDiscoverHandler } from "./agent-discover.js";
import { agentStatusHandler } from "./agent-status.js";
import { agentMessageHandler } from "./agent-message.js";

/** The Foundry Pi extension's entry point, passed to every launch as an absolute path. */
const foundryExtensionPath = (): string => fileURLToPath(import.meta.resolve("@foundry/extension"));

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

  // The configured slots of the started factories (PRD §5.2), fixed for this run like the configuration.
  const plannedSlots = factories.flatMap((f) =>
    decision.started.includes(f.factoryId) ? planSlots(f.factoryId, f.stations) : [],
  );

  // Ask the Worker Host which launch holds each slot: keep proven launches, freeze unproven
  // ownership, and launch into each vacant one (PRD §10.2 step 2), before serving. The host is
  // started only when there is a slot to run.
  let host: HostConnection | undefined;
  let channel: ChannelServer | undefined;
  let scheduler: SlotScheduler | undefined;
  let markSchedulerReady!: (ready: SlotScheduler) => void;

  const schedulerReady = new Promise<SlotScheduler>((resolve) => {
    markSchedulerReady = resolve;
  });

  let stopHost: FactoryStopperOptions["host"];
  // Each started factory's state for this run (PRD §10.3); a stopped one returns on the next start.
  const factoryStates = createFactoryStates(decision.started);

  // Frozen slots are read back from the store, so a freeze survives a daemon restart (PRD §5.3).
  // Each freeze cause registers its own unfreeze check with the ticket that raises it; until
  // then an unfreeze is refused rather than trusted. Whichever ticket wires the primer in here
  // must pass `gate: freezer` and `freeze: freezer.freeze` to `createPrimer`, with the same
  // `plannedPrimeRequests` as its `primeRequest`. Checks are read at unfreeze time, so one
  // registered below, once the scheduler exists, is honoured.
  // Made before the channel is served, so agent tool calls from a frozen slot are refused from
  // the first frame.
  const freezeChecks: FreezeChecks = {
    // PRD §5.5: a missing instruction file clears only once the slot's prime composes again.
    instruction_missing: instructionFilesCheck(plannedPrimeRequests(factories, plannedSlots)),
  };

  let freezer: SlotFreezer;

  try {
    freezer = await createSlotFreezer({ store, checks: freezeChecks });
  } catch (error) {
    log.error("frozen slots not read", { detail: { error: messageOf(error) } });
    await closeStore();
    log.close();
    claim.release();
    fail(`cannot read frozen slots in ${stateRoot}: ${messageOf(error)}`);

    return;
  }

  if (plannedSlots.length > 0) {
    try {
      host = await connectOrStartHost(stateRoot);
      const identity = await host.identify();
      stopHost = { connection: host, hostId: identity.hostId, bootId: identity.bootId };
      // Served before any launch, so a worker dialling at its session start finds the daemon. A hello
      // is accepted only for the launch the host reports current in that slot (PRD §3.2).
      // Every accepted hello is also checked against the slot's Tool Set (PRD §3.2, §14): a
      // mismatch freezes the slot and has the host stop the launch.
      const connection = host;
      const foundryExtension = foundryExtensionPath();
      const expected = new Map(plannedSlots.map((s) => [JSON.stringify([s.factoryId, s.slotId]), expectedToolSet(s.station, foundryExtension)]));

      const guard = createToolSetGuard({
        // Only the recorded current launch speaks for a slot, in the conversation the daemon issued it;
        // a changed conversation freezes the slot (PRD §3.2). Both are read from the store, so they
        // survive a restart.
        claim: createHostSlotClaim({
          host,
          storedConversation: storedConversation(store),
          currentLaunch: recordedCurrentLaunch(store),
          // The channel is served before the scheduler exists; a hello waits for it, then for its queue.
          settled: async () => (await schedulerReady).idle(),
          onConversationChanged: async (changed) => {
            const outcome = await freezer.freeze({
              factoryId: changed.factoryId,
              slotId: changed.slotId,
              cause: "conversation_changed",
              evidence: { launchId: changed.launchId, conversationRef: changed.boundRef, presentedRef: changed.presentedRef },
            });

            const refs = { factoryId: changed.factoryId, slotId: changed.slotId, launchId: changed.launchId };

            if (outcome === "frozen") {log.warn("slot frozen: conversation changed", refs);}
            else {log.error("conversation changed on a slot with no record; not frozen", refs);}
          },
        }),
        expected: (slot) => expected.get(JSON.stringify([slot.factoryId, slot.slotId])),
        freezer,
        stop: async (launchId) => {
          await connection.terminate(launchId);
        },
        onStopFailed: (launchId, cause) => log.error("mismatched launch not stopped", { launchId, detail: { error: messageOf(cause) } }),
        onFreezeFailed: (slot, cause) =>
          log.error("tool set mismatch not frozen", { factoryId: slot.factoryId, slotId: slot.slotId, detail: { error: messageOf(cause) } }),
      });

      channel = await startChannelServer({
        socketPath: channelSocketPath(stateRoot),
        slotClaim: guard,
        // Each agent tool registers its handler with its own ticket; until then calls are refused.
        toolCalls: createSubmissions({
          store,
          handlers: new Map([
            [AGENT_DISCOVER, agentDiscoverHandler(plannedSlots)],
            [AGENT_STATUS, agentStatusHandler(plannedSlots)],
            [AGENT_MESSAGE, agentMessageHandler(plannedSlots)],
          ]),
          gate: freezer,
        }),
        ...channelLogEvents(log),
      });

      scheduler = createSlotScheduler({
        store,
        stateRoot,
        host,
        hostId: identity.hostId,
        bootId: identity.bootId,
        pi: resolvePiExecutable(process.env),
        foundryExtension: foundryExtensionPath(),
        slots: plannedSlots,
        freezer,
        inScope: (factoryId) => factoryStates.isRunning(factoryId),
      });
      const recorder = scheduler;
      markSchedulerReady(scheduler);

      // PRD §10.2: prove ownership and recover any vacancy before clearing the hold.
      freezeChecks.host_lost = recorder.recheckOwnership;
      freezeChecks.unknown_ownership = recorder.recheckOwnership;
      freezeChecks.tool_set_mismatch = createToolSetRecheck({
        guard,
        conversationOf: (slot) => frozenConversation(store, slot),
        relaunch: (slot, conversationRef) => recorder.relaunch(slot, conversationRef),
        stop: async (launchId) => {
          await connection.terminate(launchId);
        },
        onStopFailed: (launchId, cause) => log.error("recheck launch not stopped", { launchId, detail: { error: messageOf(cause) } }),
      });

      // Only the host's exit report is death evidence; a lost channel never relaunches a slot (PRD §5.3).
      host.onLaunchExited((launch) => {
        void recorder.launchExited(launch).then(
          ({ ended, recovery }) => {
            if (ended) {log.info("launch ended", { factoryId: launch.factoryId, slotId: launch.slotId, launchId: launch.launchId });}

            if (recovery?.outcome === "relaunched" && recovery.launchId !== undefined) {
              log.info("slot relaunched", { factoryId: recovery.factoryId, slotId: recovery.slotId, launchId: recovery.launchId });
            } else if (recovery?.outcome === "refused") {
              log.warn("slot relaunch refused", { factoryId: recovery.factoryId, slotId: recovery.slotId, detail: { error: recovery.error ?? "" } });
            }
          },
          (cause: unknown) =>
            log.error("launch end not recorded", { factoryId: launch.factoryId, launchId: launch.launchId, detail: { error: messageOf(cause) } }),
        );
      });

      for (const result of await scheduler.schedule()) {
        const refs: LogRefs =
          result.launchId === undefined
            ? { factoryId: result.factoryId, slotId: result.slotId }
            : { factoryId: result.factoryId, slotId: result.slotId, launchId: result.launchId };

        if (result.outcome === "refused") {log.warn("slot launch refused", { ...refs, detail: { error: result.error ?? "" } });}
        else {log.info(`slot ${result.outcome}`, refs);}
      }
    } catch (error) {
      log.error("slots not scheduled", { detail: { error: messageOf(error) } });
      await channel?.close().catch(() => {});
      host?.close();
      await closeStore();
      log.close();
      claim.release();
      fail(`cannot start the slots in ${stateRoot}: ${messageOf(error)}`);

      return;
    }
  }

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
          // Closing the connections leaves the host and its launches running (PRD §3.2).
          await channel?.close().catch(() => {});
          host?.close();
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

  const sync = createFactorySyncer({
    store,
    target: (factory) => {
      const clone = clones.get(factory);
      const loaded = factories.find((f) => f.factoryId === factory);

      return stopping || clone === undefined || loaded === undefined || !factoryStates.isRunning(factory)
        ? undefined
        : { clonePath: clone.path, defaultBranch: loaded.config.repository.default_branch };
    },
    onError: (factory, error) => log.error("sync queue run failed", { factoryId: factory, detail: { error: messageOf(error) } }),
  });

  const stopperOptions = (): FactoryStopperOptions => {
    if (stopHost === undefined || scheduler === undefined) {return { store, states: factoryStates };}

    const server = channel;
    const base = { store, states: factoryStates, host: stopHost, scheduler };

    return server === undefined ? base : { ...base, drain: (launchId: string) => server.drain(launchId) };
  };

  const slotsReader = storeSlotsReader(store, stateRoot, decision.started, plannedSlots);
  const stopper = createFactoryStopper(stopperOptions());

  // The host this run connected to, else one a previous run left behind; none answering means none to stop.
  const shutdownHost = async (): Promise<ShutdownHost | undefined> => {
    if (host !== undefined) {return host;}

    try {
      const adopted = await connectHost(stateRoot);
      host = adopted;

      return adopted;
    } catch (cause) {
      const code = codeOf(cause);

      if (code === "ENOENT" || code === "ECONNREFUSED") {return undefined;}

      throw cause;
    }
  };

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
      messages: createOperatorMessages({ store, factories: () => ticketFactories.map((f) => f.name), slots: plannedSlots }),
      events: storeEventSource(store),
      clonePath: (factory) => clones.get(factory)?.path,
      sync,
      // Read from the recorded run and its configuration loads, not from memory.
      factories: storeFactoriesReader(store, log.runId, (factoryId) => factoryStates.get(factoryId)),
      // A graceful stop sends `drain` on each live worker's channel before the host terminates it.
      stopper,
      // Every factory with the scoped stop, then the Worker Host; the daemon exits 0 once answered.
      shutdown: createInstanceShutdown({ stopper, states: factoryStates, factories: decision.started, host: shutdownHost }),
      onShutdown: () => {
        if (stopping) {return;}

        stopping = true;
        log.info("daemon stopping", { detail: { signal: "shutdown" } });

        if (api !== undefined) {finish(api);}
      },
      slots: slotsReader,
      slotControl: storeSlotControl(slotsReader, freezer),
    });
  } catch (error) {
    await channel?.close().catch(() => {});
    host?.close();

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

  // Resume only accepted, not-yet-started work (PRD §9.4). An empty queue does not fetch, and a
  // running operation still blocks admission until interrupted-operation recovery handles it.
  for (const factory of decision.started) {void sync.resumeQueued(factory);}

  log.info("daemon started", {
    detail: { pid: process.pid, stateRoot, socket: api.socketPath, logLevel: log.level },
  });
  process.stdout.write(`foundry daemon: state root ${stateRoot} claimed (pid ${process.pid})\n`);
  process.stdout.write(`foundry daemon: management API on ${api.socketPath}\n`);
};

await main();
