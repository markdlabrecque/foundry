// Tier: integration. Real boundaries: a detached Worker Host owning real process groups, a real
// SQLite store file and the management socket, driven through the `foundry shutdown` core. The
// claim is that every owned kernel process group ends and then the host process itself exits,
// which only a real host can show. The one seam is the failed-to-confirm case: the real host
// cannot be made to report an unconfirmed group on demand, so its terminate answer is replaced
// there while everything else stays real.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  createFactoryStates,
  createFactoryStopper,
  createInstanceShutdown,
  createSlotFreezer,
  createSlotScheduler,
  openStore,
  planSlots,
  recordRun,
  serveManagementApi,
  storeFactoriesReader,
} from "@foundry/daemon";
import type { FactoryStates, RecordedFactory, ShutdownHost, SlotScheduler, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectHost, PI_BIN_ENV, resolvePiExecutable, startHost } from "@foundry/host";
import type { HostConnection, LaunchRecord } from "@foundry/host";
import { EXIT_OK, EXIT_REFUSED, runShutdown } from "@foundry/cli";
import { stopHost, writeStubPi } from "@foundry/testkit";
import { parseApiResponse } from "@foundry/protocol/management-api";
import { isShutdownResult } from "@foundry/protocol/shutdown-api";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const station = (name: string, instances: number): EffectiveStation => ({
  address: `eng.${name}`,
  room: "eng",
  station: name,
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions: [],
  instances,
  isolation: "none",
});

const recorded = (factoryId: string): RecordedFactory => ({
  factoryId,
  yamlFile: `/fixture/${factoryId}/factory.yaml`,
  configJson: "{}",
  configHash: `sha256:${factoryId}`,
  knowledge: { root: `/fixture/${factoryId}/knowledge`, directories: [] },
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

interface Fixture {
  readonly stateRoot: string;
  readonly store: Store;
  readonly host: HostConnection;
  readonly hostPid: number;
  readonly states: FactoryStates;
  readonly scheduler: SlotScheduler;
  readonly hostId: string;
  readonly bootId: string;
  readonly launches: ReadonlyArray<LaunchRecord>;
}

/** Two fixture factories, `alpha` (two slots) and `beta` (one), launched through a real host with the stub Pi. */
const fixture = async (): Promise<Fixture> => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foundry-shutdown-"));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const stubDir = mkdtempSync(join(tmpdir(), "foundry-stub-pi-"));
  cleanups.push(() => rmSync(stubDir, { recursive: true, force: true }));
  const pi = resolvePiExecutable({ [PI_BIN_ENV]: writeStubPi(stubDir) });

  await startHost(stateRoot);
  // Registered first so it runs last; does nothing once the shutdown has stopped the host.
  cleanups.push(() => stopHost(stateRoot));
  const host = await connectHost(stateRoot);
  cleanups.push(() => host.close());
  const { hostId, bootId, pid: hostPid } = await host.identify();

  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(stateRoot, "foundry.db") })));
  await Effect.runPromise(
    recordRun(store, { runId: "run-1", startedAt: Date.parse("2026-01-01T00:00:00.000Z"), version: "0.0.0", factories: [recorded("alpha"), recorded("beta")] }),
  );

  const states = createFactoryStates(["alpha", "beta"]);
  const slots = [...planSlots("alpha", [station("lead", 1), station("dev", 1)]), ...planSlots("beta", [station("lead", 1)])];

  const scheduler = createSlotScheduler({
    store,
    stateRoot,
    host,
    hostId,
    bootId,
    pi,
    foundryExtension: "/opt/foundry/extension.js",
    slots,
    freezer: await createSlotFreezer({ store, checks: {} }),
    inScope: (factoryId) => states.isRunning(factoryId),
  });

  expect((await scheduler.schedule()).map((r) => r.outcome)).toEqual(["started", "started", "started"]);
  const launches = (await host.inventory()).filter((l) => l.liveness === "live");

  return { stateRoot, store, host, hostPid, states, scheduler, hostId, bootId, launches };
};

const serve = async (f: Fixture, connection: ShutdownHost, drain?: (launchId: string) => Promise<void>) => {
  const base = { store: f.store, states: f.states, host: { connection, hostId: f.hostId, bootId: f.bootId }, scheduler: f.scheduler, graceMs: 200, killWaitMs: 2000 };
  const stopper = createFactoryStopper(drain === undefined ? base : { ...base, drain });
  const shutdown = createInstanceShutdown({ stopper, states: f.states, factories: ["alpha", "beta"], host: async () => connection, graceMs: 200, killWaitMs: 2000 });
  const status = () => ({ instance: { stateRoot: f.stateRoot, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } });

  const api = await serveManagementApi({
    stateRoot: f.stateRoot,
    status,
    factories: storeFactoriesReader(f.store, "run-1", (id) => f.states.get(id)),
    stopper,
    shutdown,
  });

  cleanups.push(() => api.close());
};

const historyKinds = async (store: Store, factoryId: string) =>
  (await Effect.runPromise(store.read<{ kind: string }>(`SELECT kind FROM history WHERE factory_id = ? ORDER BY sequence`, [factoryId]))).map(
    (row) => row.kind,
  );

test.each([
  { force: false, drainedExpected: true },
  { force: true, drainedExpected: false },
])("shutdown with force=$force ends every factory's groups, then the Worker Host", async ({ force, drainedExpected }) => {
  const f = await fixture();
  const drained: Array<string> = [];
  await serve(f, f.host, async (launchId) => void drained.push(launchId));

  const outcome = await runShutdown({ json: true, home: f.stateRoot, env, force });
  expect(outcome.exitCode).toBe(EXIT_OK);

  const body: unknown = JSON.parse(outcome.stdout);
  expect(body).toMatchObject({ ok: true, result: { force, hostStopped: true } });

  const reply = parseApiResponse(outcome.stdout);
  const result = reply?.ok === true && isShutdownResult(reply.result) ? reply.result : undefined;
  expect(result?.factories.map((r) => r.factoryId).sort()).toEqual(["alpha", "beta"]);

  // The normal disposition drains every worker first; force skips the drain.
  expect(drained.sort()).toEqual(drainedExpected ? f.launches.map((l) => l.launchId).sort() : []);

  // Every owned process group is gone, and then the host process itself exits.
  for (const launch of f.launches) {expect(isAlive(launch.pid)).toBe(false);}

  await expect.poll(() => isAlive(f.hostPid), { timeout: 5000 }).toBe(false);

  for (const factoryId of ["alpha", "beta"]) {
    expect(f.states.get(factoryId)).toBe("stopped");
    expect(await historyKinds(f.store, factoryId)).toEqual(expect.arrayContaining(["factory.stopping", "factory.stopped"]));
  }
});

test("a group that cannot be confirmed gone fails the shutdown and keeps the Worker Host running", async () => {
  const f = await fixture();
  const stubborn = f.launches.find((l) => l.factoryId === "alpha")!;

  // The host refuses to stop on its own while it still owns live groups.
  await expect(f.host.shutdown()).rejects.toThrow(/shutdown refused/);

  // The real host, except it reports one of alpha's groups as not confirmed gone.
  const shutdownAsks: Array<true> = [];

  const unconfirming: ShutdownHost = {
    inventory: () => f.host.inventory(),
    terminate: async (launchId, options) => {
      if (launchId !== stubborn.launchId) {return f.host.terminate(launchId, options);}

      return { outcome: "unconfirmed", escalated: true, launch: stubborn };
    },
    shutdown: () => {
      shutdownAsks.push(true);

      return f.host.shutdown();
    },
  };

  await serve(f, unconfirming);

  const outcome = await runShutdown({ json: true, home: f.stateRoot, env, force: true });
  expect(outcome.exitCode).toBe(EXIT_REFUSED);
  expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, error: { code: "shutdown_unconfirmed" } });

  // Not success: the daemon never asked the host to stop, the host still runs, alpha is still
  // stopping and its slot keeps the launch.
  expect(shutdownAsks).toEqual([]);
  expect(isAlive(f.hostPid)).toBe(true);
  expect(f.states.get("alpha")).toBe("stopping");
  expect(await historyKinds(f.store, "alpha")).not.toContain("factory.stopped");

  const [slot] = await Effect.runPromise(
    f.store.read<{ current_launch: string | null }>(`SELECT current_launch FROM slot WHERE factory_id = 'alpha' AND slot_id = ?`, [stubborn.slotId]),
  );

  expect(slot?.current_launch).toBe(stubborn.launchId);
});
