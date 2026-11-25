// Tier: integration. Real boundaries: the Unix-socket channel between the daemon's server and the
// extension's client, and a real SQLite store file holding the freeze and its hold. The Worker Host
// is a double, because these cases need it to report a stopped launch and a relaunch on demand;
// the real host's launch and terminate are proved by slots.test.ts and the host's own tests.
// Claim: a matched hello continues, a missing or replaced tool freezes the slot with the
// discrepancy and stops the launch, and unfreeze relaunches in the same conversation and rechecks.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  createHostSlotClaim,
  createSlotFreezer,
  createSlotScheduler,
  createToolSetGuard,
  createToolSetRecheck,
  expectedToolSet,
  frozenConversation,
  listOpenHolds,
  openStore,
  planSlots,
  startChannelServer,
} from "@foundry/daemon";
import type { SlotHost, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import type { LaunchRecord, LaunchSpec } from "@foundry/host";
import { openChannel } from "@foundry/extension";
import { PI_BUILTIN_TOOLS, PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello, ReportedTool } from "@foundry/protocol";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const FOUNDRY = "/opt/foundry/extension/dist/index.js";
const PROJECT = "/factory/extensions/project.ts";

const station: EffectiveStation = {
  address: "eng.builder",
  room: "eng",
  station: "builder",
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions: [{ path: PROJECT, tools: ["web_fetch"] }],
  instances: 2,
  isolation: "none",
};

const matching: ReadonlyArray<ReportedTool> = [
  ...PI_BUILTIN_TOOLS.map((name) => ({ name, source: `builtin:${name}` })),
  { name: "agent_discover", source: FOUNDRY },
  { name: "agent_message", source: FOUNDRY },
  { name: "web_fetch", source: PROJECT },
];

/** `web_fetch` missing and `read` taken over by another extension. */
const mismatched: ReadonlyArray<ReportedTool> = [
  { name: "read", source: "/rogue/extension.ts" },
  ...matching.filter((tool) => tool.name !== "read" && tool.name !== "web_fetch"),
];

/** Bounded, so a missing step fails naming the step rather than as a vitest timeout. */
const within = <A>(step: string, promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${step}`)), 2000).unref(); }),
  ]);

/** A host double that starts and stops launches on request, and lets the test await each. */
const fakeHost = () => {
  const launches: Array<LaunchRecord> = [];
  const specs: Array<LaunchSpec> = [];
  const launchWaiters: Array<(record: LaunchRecord) => void> = [];
  const stopWaiters: Array<(launchId: string) => void> = [];

  const host: SlotHost & { terminate(launchId: string): Promise<void> } = {
    inventory: async () => [...launches],
    launch: async (spec) => {
      specs.push(spec);

      const record: LaunchRecord = {
        launchId: `launch-${launches.length + 1}`,
        factoryId: spec.factoryId,
        slotId: spec.slotId,
        pid: 5000 + launches.length,
        pgid: 5000 + launches.length,
        bootId: "boot-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        liveness: "live",
      };

      launches.push(record);
      launchWaiters.splice(0).forEach((w) => w(record));

      return record;
    },
    terminate: async (launchId) => {
      const index = launches.findIndex((l) => l.launchId === launchId);
      const found = launches[index];

      if (found === undefined) {throw new Error(`no launch ${launchId}`);}

      launches[index] = { ...found, liveness: "gone", exit: { code: null, signal: "SIGTERM", endedAt: "2026-01-01T00:01:00.000Z", requested: true } };
      stopWaiters.splice(0).forEach((w) => w(launchId));
    },
  };

  const nextLaunch = () => new Promise<LaunchRecord>((resolve) => { launchWaiters.push(resolve); });
  const nextStop = () => new Promise<string>((resolve) => { stopWaiters.push(resolve); });

  return { host, specs, launches, nextLaunch, nextStop };
};

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-tool-set-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store: Store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(dir, "foundry.db") })));

  const slots = planSlots("f1", [station]);
  const fake = fakeHost();

  const checks: Parameters<typeof createSlotFreezer>[0]["checks"] = {};
  const freezer = await createSlotFreezer({ store, checks });

  const scheduler = createSlotScheduler({
    store,
    stateRoot: dir,
    host: fake.host,
    hostId: "host-1",
    bootId: "boot-1",
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: FOUNDRY,
    slots,
    freezer,
  });

  const guard = createToolSetGuard({
    claim: createHostSlotClaim({ host: fake.host }),
    expected: (slot) => (slots.some((s) => s.slotId === slot.slotId) ? expectedToolSet(station, FOUNDRY) : undefined),
    freezer,
    stop: (launchId) => fake.host.terminate(launchId),
  });

  checks.tool_set_mismatch = createToolSetRecheck({
    guard,
    conversationOf: (slot) => frozenConversation(store, slot),
    relaunch: (slot, conversationRef) => scheduler.relaunch(slot, conversationRef),
    stop: (launchId) => fake.host.terminate(launchId),
  });

  const server = await startChannelServer({ socketPath: join(dir, "channel.sock"), slotClaim: guard });
  cleanups.push(() => server.close());

  /** The Pi session ID the slot's latest launch was given, which a real worker reports as its conversation. */
  const sessionOf = (slotId: string): string => {
    const args = fake.specs.filter((s) => s.slotId === slotId).at(-1)?.args ?? [];
    const ref = args[args.indexOf("--session-id") + 1];

    if (!args.includes("--session-id") || ref === undefined) {throw new Error(`no --session-id on ${slotId}'s launch`);}

    return ref;
  };

  const say = async (slotId: string, launchId: string, tools: ReadonlyArray<ReportedTool>) => {
    const hello: Hello = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      factoryId: "f1",
      slotId,
      launchId,
      conversationRef: sessionOf(slotId),
      hasRecoverableHistory: true,
      mode: "headless",
      tools,
    };

    const opened = await openChannel({ socketPath: server.socketPath, hello, heartbeatIntervalMs: 60_000 });

    if (opened.accepted) {cleanups.push(() => opened.channel.close());}

    return opened;
  };

  return { store, scheduler, freezer, fake, say, sessionOf };
};

test("a matched hello continues; a mismatched one freezes its slot with the discrepancy and stops its launch", async () => {
  const { store, scheduler, freezer, fake, say, sessionOf } = await fixture();
  expect((await scheduler.schedule()).map((r) => [r.slotId, r.outcome, r.launchId])).toEqual([
    ["builder/1", "started", "launch-1"],
    ["builder/2", "started", "launch-2"],
  ]);

  expect((await say("builder/2", "launch-2", [...matching].reverse())).accepted).toBe(true);

  const stopped = fake.nextStop();
  const refused = await say("builder/1", "launch-1", mismatched);

  expect(refused).toEqual({ accepted: false, reason: expect.objectContaining({ kind: "terminal", code: "tool_set_mismatch" }) });
  expect(await within("the mismatched launch stopped", stopped)).toBe("launch-1");
  expect(freezer.isFrozen({ factoryId: "f1", slotId: "builder/1" })).toBe(true);
  expect(freezer.isFrozen({ factoryId: "f1", slotId: "builder/2" })).toBe(false);
  expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([
    {
      kind: "frozen_slot",
      subject: "builder/1",
      evidence: {
        cause: "tool_set_mismatch",
        launchId: "launch-1",
        conversationRef: sessionOf("builder/1"),
        missing: [{ name: "web_fetch", source: PROJECT }],
        extra: [],
        replaced: [{ name: "read", expected: "builtin:read", actual: "/rogue/extension.ts" }],
      },
    },
  ]);
  // The other slot keeps its launch.
  expect(fake.launches.find((l) => l.launchId === "launch-2")?.liveness).toBe("live");
});

test("unfreeze relaunches in the same conversation: still mismatched stays frozen, corrected unfreezes", async () => {
  const { store, scheduler, freezer, fake, say, sessionOf } = await fixture();
  await scheduler.schedule();
  const slot = { factoryId: "f1", slotId: "builder/1" };
  const conversation = sessionOf("builder/1");

  const firstStop = fake.nextStop();
  await say("builder/1", "launch-1", mismatched);
  await within("the mismatched launch stopped", firstStop);

  // The recheck's new launch still reports the wrong tools: it is stopped and the slot stays frozen.
  const relaunched = fake.nextLaunch();
  const recheckStop = fake.nextStop();
  const stillFrozen = freezer.unfreeze(slot);
  const third = await within("the first recheck launch", relaunched);
  expect((await say("builder/1", third.launchId, mismatched)).accepted).toBe(false);
  expect(await within("the first recheck's result", stillFrozen)).toMatchObject({ outcome: "cause_persists", cause: "tool_set_mismatch" });
  expect(await within("the recheck launch stopped", recheckStop)).toBe(third.launchId);
  expect(freezer.isFrozen(slot)).toBe(true);

  // Corrected: the next relaunch continues the same conversation and its hello matches.
  const corrected = fake.nextLaunch();
  const unfrozen = freezer.unfreeze(slot);
  const fourth = await within("the second recheck launch", corrected);
  expect((await say("builder/1", fourth.launchId, matching)).accepted).toBe(true);
  expect(await within("the second recheck's result", unfrozen)).toMatchObject({ outcome: "unfrozen" });

  expect(freezer.isFrozen(slot)).toBe(false);
  expect(await Effect.runPromise(listOpenHolds(store))).toEqual([]);
  // Every relaunch resumed the frozen conversation by its Pi session ID.
  const sessions = fake.specs.filter((s) => s.slotId === "builder/1").map((s) => s.args[s.args.indexOf("--session-id") + 1]);
  expect(sessions).toEqual([conversation, conversation, conversation]);
  expect(fake.launches.find((l) => l.launchId === fourth.launchId)?.liveness).toBe("live");
});
