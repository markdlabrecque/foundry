// Integration tier: a real SQLite store file with a Worker Host double. These cases need host
// reports the real host cannot be made to give on demand (a lost registry after a host restart,
// two live launches in one slot); the real host's behaviour is proved by test/slots.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { createSlotScheduler, openStore, planSlots } from "@foundry/daemon";
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

const scheduler = (store: Store, stateRoot: string, host: SlotHost, hostId: string, stations: ReadonlyArray<EffectiveStation>) =>
  createSlotScheduler({
    store,
    stateRoot,
    host,
    hostId,
    bootId: "boot-1",
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: "/opt/foundry/extension.js",
    slots: planSlots("alpha", stations),
  });

test("a launch requested of an earlier host in this boot is never requested again", async () => {
  const { stateRoot, store } = await openTempStore();
  // The first host's answer is lost: the request stays pending.
  const lost = fakeHost([], new Error("worker host connection closed"));
  const first = await scheduler(store, stateRoot, lost.host, "host-1", [station("lead", 1)]).schedule();
  expect(first.map((r) => r.outcome)).toEqual(["refused"]);

  // A restarted host on the same boot lost its registry; the launch may still be running.
  const restarted = fakeHost([]);
  const after = await scheduler(store, stateRoot, restarted.host, "host-2", [station("lead", 1)]).schedule();

  expect(after.map((r) => [r.slotId, r.outcome])).toEqual([["lead/1", "unconfirmed"]]);
  expect(restarted.asked).toEqual([]);
});

test("a launch the host refused is not pending: a later host in this boot launches into the slot", async () => {
  const { stateRoot, store } = await openTempStore();
  const refusing = fakeHost([], new HostRefusedError("launch", "launch failed to start: spawn ENOENT"));
  const first = await scheduler(store, stateRoot, refusing.host, "host-1", [station("lead", 1)]).schedule();
  expect(first.map((r) => r.outcome)).toEqual(["refused"]);

  const restarted = fakeHost([]);
  const after = await scheduler(store, stateRoot, restarted.host, "host-2", [station("lead", 1)]).schedule();

  expect(after.map((r) => [r.slotId, r.outcome])).toEqual([["lead/1", "started"]]);
  expect(restarted.asked.map((spec) => spec.slotId)).toEqual(["lead/1"]);
});

test("two live launches in one slot are reported, and neither is picked nor joined by a third", async () => {
  const { stateRoot, store } = await openTempStore();
  const { host, asked } = fakeHost([live("a", "dev/1"), live("b", "dev/1")]);

  const results = await scheduler(store, stateRoot, host, "host-1", [station("dev", 1)]).schedule();

  expect(results.map((r) => [r.slotId, r.outcome])).toEqual([["dev/1", "duplicate"]]);
  expect(asked).toEqual([]);
});

test("a slot whose launch cannot be built is refused alone; the other slots start", async () => {
  const { stateRoot, store } = await openTempStore();
  const { host, asked } = fakeHost([]);
  const broken = station("lead", 1, [{ path: "relative/extension.ts", tools: [] }]);

  const results = await scheduler(store, stateRoot, host, "host-1", [broken, station("dev", 1)]).schedule();

  expect(results.map((r) => [r.slotId, r.outcome])).toEqual([["lead/1", "refused"], ["dev/1", "started"]]);
  expect(results[0]?.error).toContain("absolute path");
  expect(asked.map((spec) => spec.slotId)).toEqual(["dev/1"]);
});
