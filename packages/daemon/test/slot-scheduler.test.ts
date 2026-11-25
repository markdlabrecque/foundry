// Integration tier: a real SQLite store file with a Worker Host double. These cases need host
// reports the real host cannot be made to give on demand (a lost registry after a host restart,
// two live launches in one slot); the real host's behaviour is proved by test/slots.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { createHostSlotClaim, createSlotFreezer, createSlotScheduler, listOpenHolds, openStore, ownershipCheck, planSlots, recordedCurrentLaunch } from "@foundry/daemon";
import type { SlotClaimResult } from "@foundry/daemon";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { SlotHost, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { HostRefusedError } from "@foundry/host";
import type { LaunchRecord, LaunchSpec } from "@foundry/host";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const station = (name: string, instances: number, extensions: EffectiveStation["extensions"] = []): EffectiveStation => ({
  address: `eng.${name}`,
  room: "eng",
  station: name,
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions,
  instances,
  isolation: "none",
});

const live = (launchId: string, slotId: string): LaunchRecord => ({
  launchId,
  factoryId: "alpha",
  slotId,
  pid: 4242,
  pgid: 4242,
  bootId: "boot-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  liveness: "live",
});

/** A host double: reports `inventory`, and records every launch asked of it. */
const fakeHost = (inventory: Array<LaunchRecord>, failure?: Error) => {
  const asked: Array<LaunchSpec> = [];

  const host: SlotHost = {
    inventory: async () => inventory,
    launch: async (spec) => {
      asked.push(spec);

      if (failure !== undefined) {throw failure;}

      const launched = live(`launch-${asked.length}`, spec.slotId);
      inventory.push(launched);

      return launched;
    },
  };

  return { host, asked };
};

const openTempStore = async (): Promise<{ stateRoot: string; store: Store }> => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foundry-scheduler-"));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(stateRoot, "foundry.db") })));

  return { stateRoot, store };
};

const scheduler = async (store: Store, stateRoot: string, host: SlotHost, hostId: string, stations: ReadonlyArray<EffectiveStation>) =>
  createSlotScheduler({
    store,
    stateRoot,
    host,
    hostId,
    bootId: "boot-1",
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: "/opt/foundry/extension.js",
    slots: planSlots("alpha", stations),
    freezer: await createSlotFreezer({ store, checks: {} }),
  });

test("a launch requested of an earlier host in this boot is never requested again; the slot freezes as host lost", async () => {
  const { stateRoot, store } = await openTempStore();
  // The first host's answer is lost: the request stays pending.
  const lost = fakeHost([], new Error("worker host connection closed"));
  const first = await (await scheduler(store, stateRoot, lost.host, "host-1", [station("lead", 1)])).schedule();
  expect(first.map((r) => r.outcome)).toEqual(["refused"]);

  // A restarted host on the same boot lost its registry; the launch may still be running.
  const restarted = fakeHost([]);
  const after = await (await scheduler(store, stateRoot, restarted.host, "host-2", [station("lead", 1)])).schedule();

  expect(after.map((r) => [r.slotId, r.outcome])).toEqual([["lead/1", "frozen"]]);
  expect(restarted.asked).toEqual([]);
  expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([
    { kind: "frozen_slot", subject: "lead/1", evidence: { cause: "host_lost", reason: "requested_of_earlier_host" } },
  ]);
});

test("a launch the host refused is not pending: a later host in this boot launches into the slot", async () => {
  const { stateRoot, store } = await openTempStore();
  const refusing = fakeHost([], new HostRefusedError("launch", "launch failed to start: spawn ENOENT"));
  const first = await (await scheduler(store, stateRoot, refusing.host, "host-1", [station("lead", 1)])).schedule();
  expect(first.map((r) => r.outcome)).toEqual(["refused"]);

  const restarted = fakeHost([]);
  const after = await (await scheduler(store, stateRoot, restarted.host, "host-2", [station("lead", 1)])).schedule();

  expect(after.map((r) => [r.slotId, r.outcome])).toEqual([["lead/1", "started"]]);
  expect(restarted.asked.map((spec) => spec.slotId)).toEqual(["lead/1"]);
});

test("two live launches in one slot freeze it, and neither is picked nor joined by a third", async () => {
  const { stateRoot, store } = await openTempStore();
  const { host, asked } = fakeHost([live("a", "dev/1"), live("b", "dev/1")]);

  const results = await (await scheduler(store, stateRoot, host, "host-1", [station("dev", 1)])).schedule();

  expect(results.map((r) => [r.slotId, r.outcome])).toEqual([["dev/1", "frozen"]]);
  expect(asked).toEqual([]);
  expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([
    { subject: "dev/1", evidence: { cause: "unknown_ownership", reason: "several_live_launches" } },
  ]);
});

test("a slot whose launch cannot be built is refused alone; the other slots start", async () => {
  const { stateRoot, store } = await openTempStore();
  const { host, asked } = fakeHost([]);
  const broken = station("lead", 1, [{ path: "relative/extension.ts", tools: [] }]);

  const results = await (await scheduler(store, stateRoot, host, "host-1", [broken, station("dev", 1)])).schedule();

  expect(results.map((r) => [r.slotId, r.outcome])).toEqual([["lead/1", "refused"], ["dev/1", "started"]]);
  expect(results[0]?.error).toContain("absolute path");
  expect(asked.map((spec) => spec.slotId)).toEqual(["dev/1"]);
});

test("unfreezing a lost host's slot is refused on the same boot; after a reboot it records the end and unfreezes", async () => {
  const { stateRoot, store } = await openTempStore();
  const stations = [station("lead", 1)];
  const slots = planSlots("alpha", stations);
  const lead = { factoryId: "alpha", slotId: "lead/1" };
  await (await scheduler(store, stateRoot, fakeHost([]).host, "host-1", stations)).schedule();
  expect(await recordedCurrentLaunch(store)("alpha", "lead/1")).toBe("launch-1");

  // A restarted host on the same boot lost its registry: the recorded launch may still run.
  const lost = fakeHost([]);
  expect((await (await scheduler(store, stateRoot, lost.host, "host-2", stations)).schedule()).map((r) => r.outcome)).toEqual(["frozen"]);

  const sameBoot = await createSlotFreezer({
    store,
    checks: { host_lost: ownershipCheck(store, lost.host, { hostId: "host-2", bootId: "boot-1" }, slots) },
  });

  expect(await sameBoot.unfreeze(lead)).toMatchObject({
    outcome: "cause_persists",
    cause: "host_lost",
    evidence: { reason: "recorded_launch_unknown_to_host", launchId: "launch-1" },
  });

  // A host on a new boot proves the launch gone: the end is recorded before the slot is unfrozen.
  const rebooted = await createSlotFreezer({
    store,
    checks: { host_lost: ownershipCheck(store, fakeHost([]).host, { hostId: "host-3", bootId: "boot-2" }, slots) },
  });

  expect(await rebooted.unfreeze(lead)).toMatchObject({ outcome: "unfrozen" });
  expect(await Effect.runPromise(store.read<{ end_reason: string | null }>(`SELECT end_reason FROM launch WHERE launch_id = 'launch-1'`))).toEqual([
    { end_reason: "machine_restarted" },
  ]);
  expect(await recordedCurrentLaunch(store)("alpha", "lead/1")).toBeNull();
  expect(await Effect.runPromise(listOpenHolds(store))).toEqual([]);
});

test("a worker that dials between the host's start reply and its record is accepted once scheduling settles", async () => {
  const { stateRoot, store } = await openTempStore();
  const inventory: Array<LaunchRecord> = [];
  let pendingClaim: Promise<SlotClaimResult> | undefined;

  const claim = createHostSlotClaim({
    host: { inventory: async () => inventory },
    currentLaunch: recordedCurrentLaunch(store),
    // Read only once a hello is claimed, after `sched` below is assigned.
    settled: () => sched.idle(),
  });

  // The host has started the launch; its worker dials before the daemon records the reply.
  const host: SlotHost = {
    inventory: async () => inventory,
    launch: async (spec) => {
      const launched = live("launch-1", spec.slotId);
      inventory.push(launched);
      pendingClaim = claim.claim({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        factoryId: "alpha",
        slotId: spec.slotId,
        launchId: "launch-1",
        conversationRef: "conv-1",
        hasRecoverableHistory: false,
        mode: "headless",
        tools: [],
      });

      return launched;
    },
  };

  const sched = await scheduler(store, stateRoot, host, "host-1", [station("lead", 1)]);
  expect((await sched.schedule()).map((r) => r.outcome)).toEqual(["started"]);
  expect(await pendingClaim).toEqual({ accepted: true, slot: { factoryId: "alpha", slotId: "lead/1", launchId: "launch-1" } });
});

test.each<[string, number | null, string | null, string]>([
  ["a clean exit (code 0) is recorded and not relaunched", 0, null, "ended"],
  ["a non-zero exit is relaunched in the same conversation", 7, null, "relaunched"],
  ["a death by signal is relaunched in the same conversation", null, "SIGKILL", "relaunched"],
])("%s", async (_name, code, signal, outcome) => {
  const { stateRoot, store } = await openTempStore();
  const inventory: Array<LaunchRecord> = [];
  const { host, asked } = fakeHost(inventory);
  const slots = await scheduler(store, stateRoot, host, "host-1", [station("lead", 1)]);
  await slots.schedule();

  const gone: LaunchRecord = { ...live("launch-1", "lead/1"), liveness: "gone", exit: { code, signal, endedAt: "2026-01-01T00:05:00.000Z" } };
  inventory[0] = gone;
  const exited = await slots.launchExited(gone);

  expect(exited.ended).toBe(true);
  expect(exited.recovery?.outcome ?? "ended").toBe(outcome);

  const sessionIds = asked.map((spec) => spec.args[spec.args.indexOf("--session-id") + 1]);
  expect(sessionIds).toHaveLength(outcome === "relaunched" ? 2 : 1);
  expect(new Set(sessionIds).size).toBe(1);
});
