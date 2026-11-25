// Integration tier: a real SQLite store file with a Worker Host double. These cases need host
// reports the real host cannot be made to give on demand (a lost registry after a host restart,
// two live launches in one slot); the real host's behaviour is proved by test/slots.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { createHostSlotClaim, createSlotFreezer, createSlotScheduler, listOpenHolds, openStore, planSlots, recordedCurrentLaunch, storeSlotControl, storeSlotsReader } from "@foundry/daemon";
import type { FreezeChecks, SlotClaimResult, SlotFreezer } from "@foundry/daemon";
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

const live = (launchId: string, slotId: string, bootId = "boot-1"): LaunchRecord => ({
  launchId,
  factoryId: "alpha",
  slotId,
  pid: 4242,
  pgid: 4242,
  bootId,
  startedAt: "2026-01-01T00:00:00.000Z",
  liveness: "live",
});

/** A host double: reports `inventory`, and records every launch asked of it. */
const fakeHost = (inventory: Array<LaunchRecord>, failure?: Error, bootId = "boot-1") => {
  const asked: Array<LaunchSpec> = [];

  const host: SlotHost = {
    inventory: async () => inventory,
    launch: async (spec) => {
      asked.push(spec);

      if (failure !== undefined) {throw failure;}

      const launched = live(`${bootId}-launch-${asked.length}`, spec.slotId, bootId);
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

const scheduler = async (
  store: Store,
  stateRoot: string,
  host: SlotHost,
  hostId: string,
  stations: ReadonlyArray<EffectiveStation>,
  bootId = "boot-1",
  freezer?: SlotFreezer,
) =>
  createSlotScheduler({
    store,
    stateRoot,
    host,
    hostId,
    bootId,
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: "/opt/foundry/extension.js",
    slots: planSlots("alpha", stations),
    freezer: freezer ?? await createSlotFreezer({ store, checks: {} }),
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

test("unfreezing a lost host's slot is refused on the same boot; after a reboot it recovers in place", async () => {
  const { stateRoot, store } = await openTempStore();
  const stations = [station("lead", 1)];
  const slots = planSlots("alpha", stations);
  const lead = { factoryId: "alpha", slotId: "lead/1" };
  const first = fakeHost([]);
  await (await scheduler(store, stateRoot, first.host, "host-1", stations)).schedule();
  expect(await recordedCurrentLaunch(store)("alpha", "lead/1")).toBe("boot-1-launch-1");

  // A restarted host on the same boot lost its registry: the recorded launch may still run.
  const lost = fakeHost([]);
  expect((await (await scheduler(store, stateRoot, lost.host, "host-2", stations)).schedule()).map((r) => r.outcome)).toEqual(["frozen"]);

  const sameBootScheduler = await scheduler(store, stateRoot, lost.host, "host-2", stations);

  const sameBoot = await createSlotFreezer({ store, checks: { host_lost: sameBootScheduler.recheckOwnership } });

  expect(await sameBoot.unfreeze(lead)).toMatchObject({
    outcome: "cause_persists",
    cause: "host_lost",
    evidence: { reason: "recorded_launch_unknown_to_host", launchId: "boot-1-launch-1" },
  });

  // Startup must honour the recorded freeze even when a host on a new boot proves the launch gone.
  const inventory: Array<LaunchRecord> = [];
  const afterReboot = fakeHost(inventory, undefined, "boot-2");
  let inventoryUnavailable = false;

  const host: SlotHost = {
    ...afterReboot.host,
    inventory: async () => {
      if (inventoryUnavailable) {throw new Error("worker host inventory unavailable");}

      return inventory;
    },
  };

  const checks: FreezeChecks = {};
  const rebooted = await createSlotFreezer({ store, checks });
  const sched = await scheduler(store, stateRoot, host, "host-3", stations, "boot-2", rebooted);
  checks.host_lost = sched.recheckOwnership;
  expect(await sched.schedule()).toMatchObject([{ outcome: "held" }]);
  expect(afterReboot.asked).toEqual([]);

  const reader = storeSlotsReader(store, stateRoot, ["alpha"], slots);
  const control = storeSlotControl(reader, rebooted);
  const [hold] = await Effect.runPromise(listOpenHolds(store));
  inventoryUnavailable = true;
  await expect(control.unfreeze(lead.slotId, lead.factoryId)).rejects.toMatchObject({ code: "cause_persists" });
  expect(await reader.show(lead.slotId, lead.factoryId)).toMatchObject({ slot: { condition: "frozen" } });
  expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([
    { id: hold?.id, evidence: { cause: "host_lost", reason: "host_inventory_unavailable" } },
  ]);

  inventoryUnavailable = false;
  inventory.push(live("orphan", lead.slotId, "boot-2"));
  await expect(control.unfreeze(lead.slotId, lead.factoryId)).rejects.toMatchObject({ code: "cause_persists" });
  expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([
    { id: hold?.id, evidence: { reason: "unrecorded_live_launch", launchId: "orphan" } },
  ]);
  expect(afterReboot.asked).toEqual([]);
  expect(await endsOf(store)).toEqual([]);
  inventory.length = 0;

  // Successful operator unfreeze must recover the slot without another daemon restart.
  expect(await control.unfreeze(lead.slotId, lead.factoryId)).toMatchObject({
    slot: { condition: "normal", launch: { launchId: "boot-2-launch-1" } },
  });
  expect(sessionIdsOf(afterReboot.asked)).toEqual(sessionIdsOf(first.asked));
  expect(await endsOf(store)).toMatchObject([
    { subject: "boot-1-launch-1", detail: { reason: "machine_restarted", unexpected: true } },
  ]);
  expect(await recordedCurrentLaunch(store)("alpha", "lead/1")).toBe("boot-2-launch-1");
  expect(await Effect.runPromise(listOpenHolds(store))).toEqual([]);
});

const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });

  return { promise, resolve };
};

test("an exit that needs an ownership freeze cannot block a concurrent Tool Set unfreeze", async () => {
  const { stateRoot, store } = await openTempStore();
  const stations = [station("dev", 2)];
  const toolSlot = { factoryId: "alpha", slotId: "dev/2" };
  const inventory: Array<LaunchRecord> = [];
  const workerHost = fakeHost(inventory);
  const readingExit = latch();
  const releaseExit = latch();
  const toolRecheck = latch();
  let pauseInventory = false;

  const host: SlotHost = {
    ...workerHost.host,
    inventory: async () => {
      if (pauseInventory) {
        pauseInventory = false;
        readingExit.resolve();
        await releaseExit.promise;
      }

      return inventory;
    },
  };

  const checks: FreezeChecks = {};
  const freezer = await createSlotFreezer({ store, checks });
  const sched = await scheduler(store, stateRoot, host, "host-1", stations, "boot-1", freezer);
  await sched.schedule();
  const toolConversation = sessionIdsOf(workerHost.asked)[1]!;
  checks.tool_set_mismatch = async (slot) => {
    const recheck = sched.relaunch(slot, toolConversation);
    toolRecheck.resolve();
    await recheck;

    return { fixed: true };
  };

  await freezer.freeze({ ...toolSlot, cause: "tool_set_mismatch", evidence: {} });

  // Host reports an unexpected exit in dev/1 and an unowned replacement. No live launch
  // remains in dev/2, whose operator recheck will need the same scheduler queue.
  const gone: LaunchRecord = {
    ...live("boot-1-launch-1", "dev/1"),
    liveness: "gone",
    exit: { code: 7, signal: null, endedAt: "2026-01-01T00:05:00.000Z" },
  };

  inventory.splice(0, inventory.length, gone, live("orphan", "dev/1"));
  pauseInventory = true;
  const exit = sched.launchExited(gone);
  await readingExit.promise;
  const unfreezing = freezer.unfreeze(toolSlot);
  await toolRecheck.promise;
  releaseExit.resolve();

  expect(await unfreezing).toMatchObject({ outcome: "unfrozen" });
  expect(await exit).toMatchObject({ ended: true, recovery: { outcome: "frozen" } });
  expect(await recordedCurrentLaunch(store)("alpha", toolSlot.slotId)).toBe("boot-1-launch-3");
  expect(workerHost.asked.map((spec) => spec.slotId)).toEqual(["dev/1", "dev/2", "dev/2"]);
  expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([
    { subject: "dev/1", evidence: { cause: "unknown_ownership", reason: "unrecorded_live_launch" } },
  ]);
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

  const gone: LaunchRecord = { ...live("boot-1-launch-1", "lead/1"), liveness: "gone", exit: { code, signal, endedAt: "2026-01-01T00:05:00.000Z" } };
  inventory[0] = gone;
  const exited = await slots.launchExited(gone);

  expect(exited.ended).toBe(true);
  expect(exited.recovery?.outcome ?? "ended").toBe(outcome);

  const sessionIds = asked.map((spec) => spec.args[spec.args.indexOf("--session-id") + 1]);
  expect(sessionIds).toHaveLength(outcome === "relaunched" ? 2 : 1);
  expect(new Set(sessionIds).size).toBe(1);
});

/** The `--session-id` each launch asked of a host double was started with. */
const sessionIdsOf = (asked: ReadonlyArray<LaunchSpec>) => asked.map((spec) => spec.args[spec.args.indexOf("--session-id") + 1]);

const endsOf = async (store: Store) => {
  const rows = await Effect.runPromise(store.read<{ subject: string; detail: string }>(`SELECT subject, detail FROM history WHERE kind = 'launch.ended'`));

  return rows.map((row) => {
    const detail: unknown = JSON.parse(row.detail);

    return { subject: row.subject, detail };
  });
};

test("a host from a new boot proves the slot vacant: it gets a recovery launch in its conversation, counted; the same loss on the same boot freezes", async () => {
  const stations = [station("lead", 1)];

  /** A store whose lead/1 holds a launch started by host-1 on boot-1, with that launch's conversation. */
  const launched = async () => {
    const { stateRoot, store } = await openTempStore();
    const first = fakeHost([]);
    await (await scheduler(store, stateRoot, first.host, "host-1", stations)).schedule();

    return { stateRoot, store, conversation: sessionIdsOf(first.asked)[0] };
  };

  // The machine restarted: a host on boot-2 does not know boot-1's launch, which is proof it is gone.
  const reboot = await launched();
  const afterReboot = fakeHost([], undefined, "boot-2");
  const rebooted = await (await scheduler(reboot.store, reboot.stateRoot, afterReboot.host, "host-2", stations, "boot-2")).schedule();

  expect(rebooted).toEqual([{ factoryId: "alpha", slotId: "lead/1", outcome: "relaunched", launchId: "boot-2-launch-1" }]);
  expect(sessionIdsOf(afterReboot.asked)).toEqual([reboot.conversation]);
  expect(await recordedCurrentLaunch(reboot.store)("alpha", "lead/1")).toBe("boot-2-launch-1");
  expect(await endsOf(reboot.store)).toMatchObject([
    { subject: "boot-1-launch-1", detail: { slotId: "lead/1", reason: "machine_restarted", unexpected: true } },
  ]);
  expect(await Effect.runPromise(listOpenHolds(reboot.store))).toEqual([]);

  // The same loss on the same boot proves nothing: the launch may still run, so nothing is launched or counted.
  const sameBoot = await launched();
  const lost = fakeHost([]);
  const frozen = await (await scheduler(sameBoot.store, sameBoot.stateRoot, lost.host, "host-2", stations)).schedule();

  expect(frozen.map((r) => [r.slotId, r.outcome, r.launchId])).toEqual([["lead/1", "frozen", "boot-1-launch-1"]]);
  expect(lost.asked).toEqual([]);
  expect(await endsOf(sameBoot.store)).toEqual([]);
  expect(await Effect.runPromise(listOpenHolds(sameBoot.store))).toMatchObject([
    { kind: "frozen_slot", subject: "lead/1", evidence: { cause: "host_lost", reason: "recorded_launch_unknown_to_host" } },
  ]);
});
