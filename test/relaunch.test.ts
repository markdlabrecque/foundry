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
import { createHostSlotClaim, createPrimer, createReconciler, createSlotFreezer, createSlotScheduler, openStore, planSlots, recordedCurrentLaunch, serveManagementApi, slotDirectory, startChannelServer, storeSlotsReader } from "@foundry/daemon";
import type { LaunchExitResult } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectHost, PI_BIN_ENV, resolvePiExecutable, startHost } from "@foundry/host";
import { openChannel } from "@foundry/extension";
import { runSlotRestart } from "@foundry/cli";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { ChannelServer } from "@foundry/daemon";
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
const fixture = async (stations: ReadonlyArray<EffectiveStation>, revokeSlot?: (factoryId: string, slotId: string) => void) => {
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
    terminate: (launchId) => host.terminate(launchId, { graceMs: 0 }),
    revokeSlot: (factory, slot) => revokeSlot?.(factory, slot),
    pi: resolvePiExecutable({ [PI_BIN_ENV]: writeStubPi(stubDir) }),
    foundryExtension: "/opt/foundry/extension.js",
    slots,
    freezer: await createSlotFreezer({ store, checks: {} }),
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

test("operator restart replaces only the owned launch, reconciles its existing conversation and keeps its counter", async () => {
  const f = await fixture([station("lead"), station("dev")], (factory, slot) => channel.revokeSlot(factory, slot));
  const { stateRoot, host, store, scheduler } = f;
  const [first, other] = await scheduler.schedule();
  const original = first!.launchId!;
  const conversationRef = (await sessionIdOf(stateRoot, "lead/1", original))!;
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE slot SET recovery_count = 1 WHERE slot_id = 'lead/1'`);
    yield* change.recordHistory({ factoryId: "alpha", kind: "fixture.counter", subject: "lead/1" });
  })));

  const primer = createPrimer({ store, primeRequest: () => ({
    address: "eng.lead", slotId: "lead/1", isolation: "none", instructions: [],
    knowledgeRoot: stateRoot, baseDir: stateRoot,
  }) });

  const reconciler = createReconciler(store);
  const outcomes: Array<Promise<unknown>> = [];

  const channel: ChannelServer = await startChannelServer({
    socketPath: join(stateRoot, "channel.sock"),
    slotClaim: createHostSlotClaim({ host, currentLaunch: recordedCurrentLaunch(store), settled: () => scheduler.idle() }),
    onAccepted: (slot, hello, accepted) => {
      outcomes.push(reconciler.reconcile(slot, hello, accepted).then(() => primer.prime(slot, hello, accepted).outcome));
    },
    onFrame: (slot, frame) => {
      if (frame.type === "reconciliation_answer") {reconciler.receive(slot, frame);}
    },
  });

  cleanups.push(() => channel.close());

  const connect = async (launchId: string, hasRecoverableHistory: boolean) => {
    let gotPrime!: (text: string) => void;
    const prime = new Promise<string>((resolve) => { gotPrime = resolve; });

    const opened = await openChannel({ socketPath: channel.socketPath, hello: {
      type: "hello", protocolVersion: PROTOCOL_VERSION, factoryId: "alpha", slotId: "lead/1",
      launchId, conversationRef, hasRecoverableHistory, mode: "headless", tools: [],
    }, onFrame: (frame, connection) => {
      if (frame.type === "prime") {gotPrime(frame.text);}
      else if (frame.type === "reconcile") {
        void connection.send({ type: "reconciliation_answer", requestId: frame.requestId,
          answers: frame.ids.map((id) => ({ id, status: "history" })) });
      }
    } });

    if (!opened.accepted) {throw new Error("channel refused");}

    cleanups.push(() => opened.channel.close());

    return { channel: opened.channel, prime };
  };

  const old = await connect(original, false);
  expect(await old.prime).toContain("Situation: fresh");
  const reader = storeSlotsReader(store, stateRoot, ["alpha"], f.slots);

  const api = await serveManagementApi({ stateRoot, status: () => ({ instance: { stateRoot, daemonPid: process.pid, startedAt: "now" } }),
    slotRestarter: { restart: async (id, factory) => {
      const shown = await reader.show(id, factory);
      await scheduler.restart({ factoryId: shown.slot.factoryId, slotId: id });

      return reader.show(id, shown.slot.factoryId);
    } },
  });

  cleanups.push(() => api.close());
  host.onLaunchExited((launch) => void scheduler.launchExited(launch));
  const restarted = await runSlotRestart({ json: true, home: stateRoot, factory: "alpha", slot: "lead/1", env: {} });
  expect(restarted.exitCode).toBe(0);
  await old.channel.closed;
  const current = (await reader.show("lead/1", "alpha")).slot.launch!.launchId;
  expect(current).not.toBe(original);
  expect(await sessionIdOf(stateRoot, "lead/1", current)).toBe(conversationRef);
  const replacement = await connect(current, true);
  expect(await replacement.prime).toContain("Situation: recovery");
  await Promise.all(outcomes);
  await scheduler.idle();
  expect((await host.inventory()).filter((l) => l.liveness === "live").map((l) => l.launchId).sort()).toEqual([current, other!.launchId!].sort());
  expect(await Effect.runPromise(store.read(`SELECT recovery_count FROM slot WHERE slot_id = 'lead/1'`))).toEqual([{ recovery_count: 1 }]);
  const ended = await Effect.runPromise(store.read<{ detail: string }>(`SELECT detail FROM history WHERE kind = 'launch.ended' AND subject = ?`, [original]));
  expect(ended.map((row) => decodeDetail(row.detail))).toEqual([expect.objectContaining({ reason: "requested", unexpected: false })]);
});

test("a launch the host stops on request is not relaunched", async () => {
  const { host, scheduler } = await fixture([station("lead")]);

  const [first] = await scheduler.schedule();
  const termination = await host.terminate(first!.launchId!, { graceMs: 0 });

  expect(await scheduler.launchExited(termination.launch)).toEqual({ ended: true });
  expect((await scheduler.schedule()).map((r) => r.outcome)).toEqual(["ended"]);
  expect(await host.inventory()).toHaveLength(1);
});
