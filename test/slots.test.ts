// Tier: integration. Real boundaries: a detached Worker Host owning real process groups, a real
// SQLite store file, and a stub Pi executable (FOUNDRY_PI_BIN) in place of the pinned Pi. The
// claim is that configured capacity becomes slots, each launched once through the host, however
// often scheduling runs; only a real host can show what it actually started.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import { createSlotScheduler, openStore, planSlots, slotDirectory, storeSlotsReader } from "@foundry/daemon";
import type { PlannedSlot, SlotScheduler, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectHost, PI_BIN_ENV, resolvePiExecutable, startHost } from "@foundry/host";
import type { HostConnection } from "@foundry/host";
import { STUB_PI_RECORD, stopHost, writeStubPi } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

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

interface Fixture {
  readonly stateRoot: string;
  readonly store: Store;
  readonly host: HostConnection;
  readonly hostId: string;
  readonly bootId: string;
  readonly slots: ReadonlyArray<PlannedSlot>;
  readonly scheduler: () => SlotScheduler;
}

/** A disposable state root with a running host, an open store and the stub Pi. */
const fixture = async (): Promise<Fixture> => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foundry-slots-"));
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

  // One persistent station (one slot) and one pooled station (three slots).
  const slots = planSlots("alpha", [station("lead", 1), station("dev", 3)]);

  const scheduler = () =>
    createSlotScheduler({ store, stateRoot, host, hostId, bootId, pi, foundryExtension: "/opt/foundry/extension.js", slots });

  return { stateRoot, store, host, hostId, bootId, slots, scheduler };
};

/** What the stub Pi recorded about its own launch. */
const decodeStubRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ argv: Schema.Array(Schema.String), slotId: Schema.String, launchId: Schema.String })),
);

const liveBySlot = async (host: HostConnection) =>
  (await host.inventory()).filter((l) => l.liveness === "live").map((l) => `${l.factoryId} ${l.slotId}`).sort((a, b) => a.localeCompare(b));

test("a persistent and a pooled station get one launch per slot, however often scheduling runs", async () => {
  const f = await fixture();
  const scheduler = f.scheduler();

  const first = await scheduler.schedule();
  expect(first.map((r) => [r.slotId, r.outcome])).toEqual([
    ["lead/1", "started"],
    ["dev/1", "started"],
    ["dev/2", "started"],
    ["dev/3", "started"],
  ]);

  // Repeated, concurrent, and from a fresh scheduler (a daemon restart): nothing new starts.
  const again = await Promise.all([scheduler.schedule(), scheduler.schedule(), f.scheduler().schedule()]);

  for (const results of again) {expect(results.map((r) => r.outcome)).toEqual(["running", "running", "running", "running"]);}

  const inventory = await f.host.inventory();
  expect(inventory).toHaveLength(4);
  expect(await liveBySlot(f.host)).toEqual(["alpha dev/1", "alpha dev/2", "alpha dev/3", "alpha lead/1"]);

  // Each launch ran in its slot's neutral folder with the host-issued identity and the RPC argv.
  for (const launch of inventory) {
    const record = join(slotDirectory(f.stateRoot, "alpha", launch.slotId), STUB_PI_RECORD);
    await expect.poll(() => existsSync(record)).toBe(true);
    const seen = decodeStubRecord(readFileSync(record, "utf8"));
    expect(seen).toMatchObject({ slotId: launch.slotId, launchId: launch.launchId });
    expect(seen.argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--model", "faux/scripted"]));
  }

  const kinds = await Effect.runPromise(f.store.read<{ kind: string }>(`SELECT kind FROM history ORDER BY sequence`));
  expect(kinds.map((k) => k.kind)).toEqual(Array.from({ length: 4 }, () => ["launch.requested", "launch.started"]).flat());

  // The observations the management API serves.
  const reader = storeSlotsReader(f.store, f.stateRoot, ["alpha"], f.slots);
  const listed = await reader.list(undefined);
  expect(listed.slots.map((s) => [s.slotId, s.station, s.ordinal, s.condition, s.launch?.origin, s.launch?.endedAt])).toEqual([
    ["lead/1", "eng.lead", 1, "normal", "started", null],
    ["dev/1", "eng.dev", 1, "normal", "started", null],
    ["dev/2", "eng.dev", 2, "normal", "started", null],
    ["dev/3", "eng.dev", 3, "normal", "started", null],
  ]);
});

test("a live launch the daemon never recorded is adopted, not duplicated; an ended one is not relaunched", async () => {
  const f = await fixture();
  // The daemon died before saving the start reply: the host has dev/2 live, the store nothing.
  const orphan = await f.host.launch({ factoryId: "alpha", slotId: "dev/2", command: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"], cwd: f.stateRoot });

  const scheduler = f.scheduler();
  const results = await scheduler.schedule();
  expect(results.find((r) => r.slotId === "dev/2")).toMatchObject({ outcome: "adopted", launchId: orphan.launchId });
  expect(await f.host.inventory()).toHaveLength(4);

  // The host ends lead/1's launch; the reported exit is recorded and scheduling leaves the slot alone.
  const lead = results.find((r) => r.slotId === "lead/1")!;
  const termination = await f.host.terminate(lead.launchId!, { graceMs: 0 });
  expect(termination.outcome).toBe("gone");
  expect(await scheduler.recordExit(termination.launch)).toBe(true);

  const later = await scheduler.schedule();
  expect(later.map((r) => [r.slotId, r.outcome])).toEqual([
    ["lead/1", "ended"],
    ["dev/1", "running"],
    ["dev/2", "running"],
    ["dev/3", "running"],
  ]);
  expect(await f.host.inventory()).toHaveLength(4);

  const shown = await storeSlotsReader(f.store, f.stateRoot, ["alpha"], f.slots).show("lead/1", undefined);
  expect(shown.launches).toEqual([
    expect.objectContaining({ launchId: lead.launchId, origin: "started", endReason: "requested", stderrPath: null }),
  ]);
});
