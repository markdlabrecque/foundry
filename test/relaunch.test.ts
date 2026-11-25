// Tier: integration. Real boundaries: a detached Worker Host owning real process groups, a real
// SQLite store file, and a stub Pi executable (FOUNDRY_PI_BIN). Only a real host can report a
// launch's death it was not asked for, which is the evidence relaunching rests on (PRD §5.3,
// §10.2). The claim: a launch that dies unasked is replaced in the same slot and conversation;
// a live launch is never replaced, since the scheduler takes no channel input at all, so a worker
// with no channel (the stub dials nothing) is kept; and a requested stop is not relaunched.
// Which exit codes count as unexpected is proved at the cheaper tier in slot-scheduler.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import { createSlotScheduler, openStore, planSlots, slotDirectory, storeSlotsReader } from "@foundry/daemon";
import type { LaunchExitResult } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectHost, PI_BIN_ENV, resolvePiExecutable, startHost } from "@foundry/host";
import { STUB_PI_RECORD, stopHost, writeStubPi } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const station = (name: string): EffectiveStation => ({
  address: `eng.${name}`,
  room: "eng",
  station: name,
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions: [],
  instances: 1,
  isolation: "none",
});

const decodeStubRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ argv: Schema.Array(Schema.String), launchId: Schema.String })),
);

const decodeDetail = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

/** A disposable state root with a running host, an open store and a scheduler over `stations`' slots. */
const fixture = async (stations: ReadonlyArray<EffectiveStation>) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foundry-relaunch-"));
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const stubDir = mkdtempSync(join(tmpdir(), "foundry-stub-pi-"));
  cleanups.push(() => rmSync(stubDir, { recursive: true, force: true }));

  await startHost(stateRoot);
  // Registered first so it runs last: the host terminates every launch it owns, then stops.
  cleanups.push(() => stopHost(stateRoot));
  const host = await connectHost(stateRoot);
  cleanups.push(() => host.close());
  const { hostId, bootId } = await host.identify();

  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(stateRoot, "foundry.db") })));
  const slots = planSlots("alpha", stations);

  const scheduler = createSlotScheduler({
    store,
    stateRoot,
    host,
    hostId,
    bootId,
    pi: resolvePiExecutable({ [PI_BIN_ENV]: writeStubPi(stubDir) }),
    foundryExtension: "/opt/foundry/extension.js",
    slots,
  });

  return { stateRoot, host, store, slots, scheduler };
};

/** The `--session-id` the stub Pi in `slotId` was launched with, once launch `launchId` has written it. */
const sessionIdOf = async (stateRoot: string, slotId: string, launchId: string): Promise<string | undefined> => {
  const path = join(slotDirectory(stateRoot, "alpha", slotId), STUB_PI_RECORD);
  await expect.poll(() => existsSync(path) && decodeStubRecord(readFileSync(path, "utf8")).launchId === launchId).toBe(true);
  const { argv } = decodeStubRecord(readFileSync(path, "utf8"));

  return argv[argv.indexOf("--session-id") + 1];
};

test("a launch that dies unasked is relaunched in the same slot and conversation; a live one without a channel is kept", async () => {
  const { stateRoot, host, store, slots, scheduler } = await fixture([station("lead"), station("dev")]);

  // Wired as the daemon wires it: the host's exit report is the only death evidence.
  const exits: Array<LaunchExitResult> = [];
  host.onLaunchExited((launch) => void scheduler.launchExited(launch).then((r) => exits.push(r)));

  const first = await scheduler.schedule();
  const lead = first.find((r) => r.slotId === "lead/1")!.launchId!;
  const dev = first.find((r) => r.slotId === "dev/1")!.launchId!;
  const conversation = await sessionIdOf(stateRoot, "lead/1", lead);
  expect(conversation).toMatch(/^[A-Za-z0-9-]+$/);

  // lead/1's worker dies without the host being asked to stop it.
  const leadPid = (await host.inventory()).find((l) => l.launchId === lead)!.pid;
  process.kill(-leadPid, "SIGKILL");
  await expect.poll(() => exits.length, { timeout: 10_000 }).toBe(1);
  expect(exits[0]).toMatchObject({ ended: true, recovery: { slotId: "lead/1", outcome: "relaunched" } });
  const relaunched = exits[0]!.recovery!.launchId!;
  expect(relaunched).not.toBe(lead);

  // The new launch opens the same conversation in the same slot folder.
  expect(await sessionIdOf(stateRoot, "lead/1", relaunched)).toBe(conversation);

  // dev/1 is live but has no channel: it is not replaced.
  const again = await scheduler.schedule();
  expect(again.map((r) => [r.slotId, r.outcome, r.launchId])).toEqual([
    ["lead/1", "running", relaunched],
    ["dev/1", "running", dev],
  ]);

  const live = (await host.inventory()).filter((l) => l.liveness === "live").map((l) => l.launchId);
  expect(live.sort()).toEqual([relaunched, dev].sort());

  const shown = await storeSlotsReader(store, stateRoot, ["alpha"], slots).show("lead/1", undefined);
  expect(shown.launches.map((l) => [l.launchId, l.endReason])).toEqual([
    [lead, "exited"],
    [relaunched, null],
  ]);

  // The unexpected end is on record for recovery accounting, which has no reader yet.
  const ended = await Effect.runPromise(
    store.read<{ detail: string }>(`SELECT detail FROM history WHERE kind = 'launch.ended' AND subject = ?`, [lead]),
  );

  expect(ended.map((row) => decodeDetail(row.detail))).toEqual([
    expect.objectContaining({ slotId: "lead/1", reason: "exited", unexpected: true, signal: "SIGKILL" }),
  ]);
});

test("a launch the host stops on request is not relaunched", async () => {
  const { host, scheduler } = await fixture([station("lead")]);

  const [first] = await scheduler.schedule();
  const termination = await host.terminate(first!.launchId!, { graceMs: 0 });

  expect(await scheduler.launchExited(termination.launch)).toEqual({ ended: true });
  expect((await scheduler.schedule()).map((r) => r.outcome)).toEqual(["ended"]);
  expect(await host.inventory()).toHaveLength(1);
});
