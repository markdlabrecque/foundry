// Tier: integration. Real boundaries: a detached Worker Host owning real process groups, a real
// SQLite store file and the management socket, driven through the `foundry factory stop` core.
// The claim is about which kernel process groups end, which only a real host can show. The one
// seam is the failed-to-confirm case: the real host cannot be made to report an unconfirmed group
// on demand, so its terminate answer is replaced there while everything else stays real.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  createFactoryStates,
  createFactoryStopper,
  createSlotFreezer,
  createSlotScheduler,
  openStore,
  planSlots,
  recordRun,
  serveManagementApi,
  storeFactoriesReader,
} from "@foundry/daemon";
import type { FactoryStates, RecordedFactory, SlotScheduler, StopHost, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectHost, PI_BIN_ENV, resolvePiExecutable, startHost } from "@foundry/host";
import type { HostConnection } from "@foundry/host";
import { EXIT_OK, EXIT_REFUSED, runFactoryList, runFactoryStop } from "@foundry/cli";
import { stopHost, writeStubPi } from "@foundry/testkit";

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
  readonly states: FactoryStates;
  readonly scheduler: SlotScheduler;
  readonly hostId: string;
  readonly bootId: string;
}

/**
 * Two fixture factories in one disposable state root: `alpha` with a persistent and a pooled
 * station, `beta` with one persistent station, all launched through a real host with the stub Pi.
 */
const fixture = async (): Promise<Fixture> => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foundry-stop-"));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const stubDir = mkdtempSync(join(tmpdir(), "foundry-stub-pi-"));
  cleanups.push(() => rmSync(stubDir, { recursive: true, force: true }));
  const pi = resolvePiExecutable({ [PI_BIN_ENV]: writeStubPi(stubDir) });

  await startHost(stateRoot);
  // Registered first so it runs last: the host terminates every launch it owns, then stops.
  cleanups.push(() => stopHost(stateRoot));
  const host = await connectHost(stateRoot);
  cleanups.push(() => host.close());
  const { hostId, bootId } = await host.identify();

  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(stateRoot, "foundry.db") })));
  await Effect.runPromise(
    recordRun(store, { runId: "run-1", startedAt: Date.parse("2026-01-01T00:00:00.000Z"), version: "0.0.0", factories: [recorded("alpha"), recorded("beta")] }),
  );

  const states = createFactoryStates(["alpha", "beta"]);
  const slots = [...planSlots("alpha", [station("lead", 1), station("dev", 2)]), ...planSlots("beta", [station("lead", 1)])];

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

  const first = await scheduler.schedule();
  expect(first.map((r) => [r.factoryId, r.slotId, r.outcome])).toEqual([
    ["alpha", "lead/1", "started"],
    ["alpha", "dev/1", "started"],
    ["alpha", "dev/2", "started"],
    ["beta", "lead/1", "started"],
  ]);

  return { stateRoot, store, host, states, scheduler, hostId, bootId };
};

const serve = async (f: Fixture, connection: StopHost, drain?: (launchId: string) => Promise<void>) => {
  const base = { store: f.store, states: f.states, host: { connection, hostId: f.hostId, bootId: f.bootId }, scheduler: f.scheduler, graceMs: 200, killWaitMs: 2000 };
  const stopper = createFactoryStopper(drain === undefined ? base : { ...base, drain });
  const status = () => ({ instance: { stateRoot: f.stateRoot, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } });

  const api = await serveManagementApi({
    stateRoot: f.stateRoot,
    status,
    factories: storeFactoriesReader(f.store, "run-1", (id) => f.states.get(id)),
    stopper,
  });

  cleanups.push(() => api.close());
};

const liveOf = async (host: HostConnection, factoryId: string) =>
  (await host.inventory()).filter((l) => l.factoryId === factoryId && l.liveness === "live");

const historyKinds = async (store: Store, factoryId: string) =>
  (await Effect.runPromise(store.read<{ kind: string }>(`SELECT kind FROM history WHERE factory_id = ? ORDER BY sequence`, [factoryId]))).map(
    (row) => row.kind,
  );

test("stopping one factory drains and ends only its process groups; the other factory keeps running", async () => {
  const f = await fixture();
  const alphaLaunches = await liveOf(f.host, "alpha");
  const [betaLaunch] = await liveOf(f.host, "beta");
  const drained: Array<string> = [];
  await serve(f, f.host, async (launchId) => void drained.push(launchId));

  const outcome = await runFactoryStop({ json: true, home: f.stateRoot, env, name: "alpha", force: false });
  expect(outcome.exitCode).toBe(EXIT_OK);
  expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, result: { factoryId: "alpha", state: "stopped", force: false } });

  // Drain went only to alpha's workers, and every one of alpha's groups is gone.
  expect(drained.sort()).toEqual(alphaLaunches.map((l) => l.launchId).sort());

  for (const launch of alphaLaunches) {expect(isAlive(launch.pid)).toBe(false);}

  expect(await liveOf(f.host, "alpha")).toEqual([]);

  // Beta's worker was never signalled.
  expect(isAlive(betaLaunch!.pid)).toBe(true);
  expect((await liveOf(f.host, "beta")).map((l) => l.launchId)).toEqual([betaLaunch!.launchId]);

  const listed = await runFactoryList({ json: false, home: f.stateRoot, env });
  expect(listed.stdout).toMatch(/^alpha {2}stopped /m);
  expect(listed.stdout).toMatch(/^beta {2}running /m);

  // No new assignment in the stopped factory's scope: scheduling launches nothing into its slots.
  const again = await f.scheduler.schedule();
  expect(again.map((r) => [r.factoryId, r.slotId, r.outcome])).toEqual([
    ["alpha", "lead/1", "stopped"],
    ["alpha", "dev/1", "stopped"],
    ["alpha", "dev/2", "stopped"],
    ["beta", "lead/1", "running"],
  ]);
  expect(await liveOf(f.host, "alpha")).toEqual([]);

  expect(await historyKinds(f.store, "alpha")).toEqual(expect.arrayContaining(["factory.stopping", "factory.stopped"]));
  expect(await historyKinds(f.store, "beta")).not.toContain("factory.stopping");

  // A stopped factory stays stopped for the run; a second stop is refused.
  const repeat = await runFactoryStop({ json: false, home: f.stateRoot, env, name: "alpha", force: true });
  expect(repeat.exitCode).toBe(EXIT_REFUSED);
  expect(repeat.stderr).toContain("already stopped");
});

test("a stop that cannot confirm a group gone fails, keeps the factory stopping and leaves the other factory alone", async () => {
  const f = await fixture();
  const [betaLaunch] = await liveOf(f.host, "beta");
  const [stubborn] = await liveOf(f.host, "alpha");

  // The real host, except it reports one of alpha's groups as not confirmed gone.
  const unconfirming: StopHost = {
    inventory: () => f.host.inventory(),
    terminate: async (launchId, options) => {
      if (launchId !== stubborn!.launchId) {return f.host.terminate(launchId, options);}

      return { outcome: "unconfirmed", escalated: true, launch: stubborn! };
    },
  };

  await serve(f, unconfirming);

  const outcome = await runFactoryStop({ json: true, home: f.stateRoot, env, name: "alpha", force: true });
  expect(outcome.exitCode).toBe(EXIT_REFUSED);
  expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, error: { code: "stop_unconfirmed" } });

  // Not success: the factory is still stopping, no `factory.stopped` was recorded, and the slot
  // still holds its launch, so it is not released for reuse.
  expect(f.states.get("alpha")).toBe("stopping");
  expect(await historyKinds(f.store, "alpha")).toContain("factory.stopping");
  expect(await historyKinds(f.store, "alpha")).not.toContain("factory.stopped");

  const [slot] = await Effect.runPromise(
    f.store.read<{ current_launch: string | null }>(`SELECT current_launch FROM slot WHERE factory_id = 'alpha' AND slot_id = ?`, [stubborn!.slotId]),
  );

  expect(slot?.current_launch).toBe(stubborn!.launchId);

  // Scheduling launches nothing into the stopping factory.
  const again = await f.scheduler.schedule();
  expect(again.filter((r) => r.factoryId === "alpha").map((r) => r.outcome)).toEqual(["stopped", "stopped", "stopped"]);

  // The other factory is untouched.
  expect(isAlive(betaLaunch!.pid)).toBe(true);

  const listed = await runFactoryList({ json: false, home: f.stateRoot, env });
  expect(listed.stdout).toMatch(/^alpha {2}stopping /m);
  expect(listed.stdout).toMatch(/^beta {2}running /m);
});
