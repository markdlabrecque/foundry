// Integration tier: a real SQLite store file with a Worker Host double. These cases need host
// reports the real host cannot be made to give on demand (a lost registry after a host restart,
// two live launches in one slot); the real host's behaviour is proved by test/slots.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import { createAssignmentScheduler, createHostSlotClaim, createSlotFreezer, createSlotScheduler, createTicketService, listOpenHolds, openStore, planSlots, recordedCurrentLaunch, storeSlotControl, storeSlotsReader, ticketFactoryFrom } from "@foundry/daemon";
import type { FreezeChecks, SlotClaimResult, SlotFreezer } from "@foundry/daemon";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { SlotHost, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { HostRefusedError } from "@foundry/host";
import type { LaunchRecord, LaunchSpec } from "@foundry/host";
import { FactoryConfig } from "../src/config/schema.js";

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
  recoveryLimit = 3,
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
    recoveryLimit: () => recoveryLimit,
    configLoad: () => "load-1",
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

const recoveryConfig = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "alpha", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", recovery_limit: 2,
  rooms: { eng: { stations: { lead: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "eng.lead" }] } },
});

const assignRecoveryTicket = async (store: Store, stateRoot: string) => {
  const tickets = createTicketService({ store, stateRoot, factories: () => [ticketFactoryFrom(recoveryConfig)] });
  await Effect.runPromise(tickets.submit({ title: "Disposable recovery ticket", spec: "Keep recovery state" }));
  await Effect.runPromise(createAssignmentScheduler({ store, slots: planSlots("alpha", [station("lead", 1)]),
    factories: [{ factoryId: "alpha", config: recoveryConfig }] }).schedule());
};

const recoveryState = (store: Store) => Effect.runPromise(Effect.all({
  slots: store.read(`SELECT condition, recovery_count FROM slot`),
  assignments: store.read(`SELECT status, recovery_count, recovery_ceiling, context_message FROM assignment`),
  tickets: store.read(`SELECT status FROM ticket`),
  holds: listOpenHolds(store),
  transitions: store.read(`SELECT from_status, to_status, config_load FROM ticket_transition WHERE to_status = 'paused'`),
  ends: store.read(`SELECT launch_id FROM launch WHERE ended_at IS NOT NULL`),
  history: store.read(`SELECT * FROM history`),
}));

const failed = (launchId: string): LaunchRecord => ({ ...live(launchId, "lead/1"), liveness: "gone",
  exit: { code: 7, signal: null, endedAt: "2026-01-01T00:05:00.000Z" } });

test.each([false, true])("parks exactly at the ceiling, atomically, with assignment=%s; replay and restart do not count", async (assigned) => {
  const { stateRoot, store } = await openTempStore();
  const inventory: Array<LaunchRecord> = [];
  const worker = fakeHost(inventory);
  const slots = await scheduler(store, stateRoot, worker.host, "host-1", [station("lead", 1)], "boot-1", undefined, 2);
  await slots.schedule();

  if (assigned) {await assignRecoveryTicket(store, stateRoot);}

  // The first end is below the ceiling, including an assigned worker's death before its first turn.
  inventory[0] = failed("boot-1-launch-1");
  expect(await slots.launchExited(inventory[0])).toMatchObject({ ended: true, recovery: { outcome: "relaunched" } });
  const first = await recoveryState(store);
  expect(first.slots).toEqual([{ condition: "normal", recovery_count: assigned ? 0 : 1 }]);
  expect(first.holds).toEqual([]);

  if (assigned) {expect(first.assignments).toMatchObject([{ status: "active", recovery_count: 1, recovery_ceiling: 2 }]);}

  expect(await slots.launchExited(inventory[0])).toEqual({ ended: false });
  await (await scheduler(store, stateRoot, worker.host, "host-1", [station("lead", 1)], "boot-1", undefined, 2)).schedule();
  expect(await recoveryState(store)).toEqual(first);

  inventory[1] = failed("boot-1-launch-2");
  expect(await slots.launchExited(inventory[1])).toMatchObject({ ended: true, recovery: { outcome: "held" } });
  const parked = await recoveryState(store);
  expect(parked.slots).toEqual([{ condition: "parked", recovery_count: assigned ? 0 : 2 }]);
  expect(parked.holds).toMatchObject([{ kind: "parked_slot", subject: "lead/1", evidence: {
    recoveryCount: 2, recoveryCeiling: 2, ticket: assigned ? 1 : null,
    launches: [{ launch_id: "boot-1-launch-1", end_reason: "exited" }, { launch_id: "boot-1-launch-2", end_reason: "exited" }],
  } }]);
  expect(parked.holds).toHaveLength(1);

  if (assigned) {
    expect(parked.assignments).toEqual([{ ...first.assignments[0], status: "suspended", recovery_count: 2 }]);
    expect(parked.tickets).toEqual([{ status: "paused" }]);
    expect(parked.transitions).toEqual([{ from_status: "assigned", to_status: "paused", config_load: "load-1" }]);
  } else {
    expect(parked.assignments).toEqual([]);
    expect(parked.tickets).toEqual([]);
    expect(parked.transitions).toEqual([]);
  }

  await slots.launchExited(inventory[1]);
  expect((await slots.schedule()).map((s) => s.outcome)).toEqual(["held"]);
  expect(await recoveryState(store)).toEqual(parked);
  expect(worker.asked).toHaveLength(2);
  await expect(slots.relaunch({ factoryId: "alpha", slotId: "lead/1" }, sessionIdsOf(worker.asked)[0] ?? ""))
    .rejects.toThrow("parked; reset is required");
  expect(worker.asked).toHaveLength(2);
});

test.each<NonNullable<LaunchRecord["exit"]>>([
  { code: 0, signal: null, endedAt: "2026-01-01T00:05:00.000Z" },
  { code: null, signal: "SIGTERM", requested: true, endedAt: "2026-01-01T00:05:00.000Z" },
])("observed non-failure end %j never counts or parks", async (exit) => {
  const { stateRoot, store } = await openTempStore();
  const inventory: Array<LaunchRecord> = [];
  const worker = fakeHost(inventory);
  const slots = await scheduler(store, stateRoot, worker.host, "host-1", [station("lead", 1)], "boot-1", undefined, 1);
  await slots.schedule();
  await assignRecoveryTicket(store, stateRoot);
  // Daemon reconciliation/channel loss with a still-live host launch records no death.
  await slots.schedule();

  const gone: LaunchRecord = { ...live("boot-1-launch-1", "lead/1"), liveness: "gone",
    exit: { ...exit, endedAt: "2026-01-01T00:05:00.000Z" } };

  inventory[0] = gone;
  await slots.launchExited(gone);
  await slots.schedule();
  const state = await recoveryState(store);
  expect(state.slots).toEqual([{ condition: "normal", recovery_count: 0 }]);
  expect(state.assignments).toMatchObject([{ status: "active", recovery_count: 0 }]);
  expect(state.tickets).toEqual([{ status: "assigned" }]);
  expect(state.holds).toEqual([]);
  expect(state.ends).toHaveLength(1);
});

test("parking failure rolls back the launch end, counter, ticket and assignment together", async () => {
  const { stateRoot, store } = await openTempStore();
  const worker = fakeHost([]);
  const slots = await scheduler(store, stateRoot, worker.host, "host-1", [station("lead", 1)]);
  await slots.schedule();
  await assignRecoveryTicket(store, stateRoot);
  // The assignment's stored ceiling, not a later factory limit, is authoritative.
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE assignment SET recovery_count = 1`);
    yield* change.query(`CREATE TRIGGER reject_parking BEFORE INSERT ON operator_hold WHEN NEW.kind = 'parked_slot'
      BEGIN SELECT RAISE(ABORT, 'fixture refuses hold'); END`);
    yield* change.recordHistory({ factoryId: "alpha", kind: "fixture", subject: "reject parking" });
  })));
  const before = await recoveryState(store);
  await expect(slots.recordExit(failed("boot-1-launch-1"))).rejects.toThrow("fixture refuses hold");
  expect(await recoveryState(store)).toEqual(before);
});

test("idle deaths stay separate from an assignment and reboot evidence parks without launching", async () => {
  const { stateRoot, store } = await openTempStore();
  const inventory: Array<LaunchRecord> = [];
  const worker = fakeHost(inventory);
  const slots = await scheduler(store, stateRoot, worker.host, "host-1", [station("lead", 1)], "boot-1", undefined, 2);
  await slots.schedule();
  inventory[0] = failed("boot-1-launch-1");
  await slots.launchExited(inventory[0]);
  await assignRecoveryTicket(store, stateRoot);
  // The prior idle death must not use up the assignment's allowance.
  inventory[1] = failed("boot-1-launch-2");
  expect(await slots.launchExited(inventory[1])).toMatchObject({ recovery: { outcome: "relaunched" } });
  expect((await recoveryState(store)).assignments).toMatchObject([{ recovery_count: 1, status: "active" }]);
  const reboot = fakeHost([], undefined, "boot-2");
  const recovered = await scheduler(store, stateRoot, reboot.host, "host-2", [station("lead", 1)], "boot-2", undefined, 2);
  expect((await recovered.schedule()).map((r) => r.outcome)).toEqual(["held"]);
  const state = await recoveryState(store);
  expect(state.slots).toEqual([{ condition: "parked", recovery_count: 1 }]);
  expect(state.assignments).toMatchObject([{ recovery_count: 2, status: "suspended" }]);
  expect(state.holds).toMatchObject([{ evidence: { launches: [
    { end_reason: "exited" }, { end_reason: "exited" }, { end_reason: "machine_restarted" },
  ] } }]);
  expect(reboot.asked).toEqual([]);
});

test.each([true, false])("parking during an in-flight unfreeze wins over its check result=%s", async (fixed) => {
  const { stateRoot, store } = await openTempStore();
  const inventory: Array<LaunchRecord> = [];
  const worker = fakeHost(inventory);
  const checkStarted = latch();
  const finishCheck = latch();

  const checks: FreezeChecks = { tool_set_mismatch: async () => {
    checkStarted.resolve();
    await finishCheck.promise;

    return fixed ? { fixed: true } : { fixed: false, evidence: { reason: "still mismatched" } };
  } };

  const freezer = await createSlotFreezer({ store, checks });
  const slots = await scheduler(store, stateRoot, worker.host, "host-1", [station("lead", 1)], "boot-1", freezer, 1);
  await slots.schedule();
  await freezer.freeze({ factoryId: "alpha", slotId: "lead/1", cause: "tool_set_mismatch", evidence: {} });
  const unfreezing = freezer.unfreeze({ factoryId: "alpha", slotId: "lead/1" });
  await checkStarted.promise;
  const queuedFreeze = freezer.freeze({ factoryId: "alpha", slotId: "lead/1", cause: "instruction_missing", evidence: {} });
  inventory[0] = failed("boot-1-launch-1");
  await slots.launchExited(inventory[0]);
  const parked = await recoveryState(store);
  expect(parked.slots).toEqual([{ condition: "parked", recovery_count: 1 }]);
  finishCheck.resolve();
  expect(await unfreezing).toEqual({ outcome: "not_frozen" });
  expect(await queuedFreeze).toBe("parked");
  expect(await freezer.unfreeze({ factoryId: "alpha", slotId: "lead/1" })).toEqual({ outcome: "not_frozen" });
  expect(await recoveryState(store)).toEqual(parked);
  expect((await slots.schedule()).map((s) => s.outcome)).toEqual(["held"]);
  expect(worker.asked).toHaveLength(1);
});
