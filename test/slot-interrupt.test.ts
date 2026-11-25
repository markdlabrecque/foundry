// Tier: integration. Real boundaries: the management API socket, the worker channel socket and a
// SQLite store file, driven through the `foundry slot interrupt` core. The Worker Host is a double
// (its launch records), and so is Pi's run control; the real Pi abort is proved by
// packages/extension/e2e/interrupt.e2e.test.ts. The claim: an interrupt through the API aborts the
// run and leaves the same slot on the same launch, bound to the same conversation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  ChannelUnavailableError,
  createHostSlotClaim,
  createSlotFreezer,
  createSlotScheduler,
  inMemorySlotConversations,
  openStore,
  planSlots,
  serveManagementApi,
  startChannelServer,
  storeSlotInterrupter,
  storeSlotsReader,
} from "@foundry/daemon";
import type { SlotChannel, SlotHost } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import type { LaunchRecord } from "@foundry/host";
import { openChannel, RunInterrupter } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
import { EXIT_OK, EXIT_REFUSED, runSlotInterrupt, runSlotShow } from "@foundry/cli";

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

const launchRecord = (launchId: string, slotId: string): LaunchRecord => ({
  launchId,
  factoryId: "alpha",
  slotId,
  pid: 4001,
  pgid: 4001,
  bootId: "boot-1",
  startedAt: "2026-02-01T00:00:00.000Z",
  liveness: "live",
});

/**
 * A daemon serving alpha's slots lead/1 (launched, its worker connected over the channel) and
 * dev/1 (never launched), with a worker whose Pi run is active until it is aborted.
 */
const daemonWithWorker = async () => {
  const home = mkdtempSync(join(tmpdir(), "foundry-slot-interrupt-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(home, "foundry.db") })));
  const slots = planSlots("alpha", [station("lead", 1), station("dev", 1)]);

  const launched: Array<LaunchRecord> = [];

  const host: SlotHost = {
    inventory: async () => launched,
    launch: async (spec) => {
      if (spec.slotId !== "lead/1") {throw new Error("worker host refused launch");}

      const record = launchRecord("launch-1", spec.slotId);
      launched.push(record);

      return record;
    },
  };

  await createSlotScheduler({
    store,
    stateRoot: home,
    host,
    hostId: "host-1",
    bootId: "boot-1",
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: "/opt/foundry/extension.js",
    slots,
    freezer: await createSlotFreezer({ store, checks: {} }),
  }).schedule();

  const conversations = inMemorySlotConversations();
  let hellos = 0;

  const channel = await startChannelServer({
    socketPath: join(home, "channel.sock"),
    slotClaim: createHostSlotClaim({ host, conversations }),
    onAccepted: () => (hellos += 1),
  });

  cleanups.push(() => channel.close());

  // The worker: an active Pi run that goes idle and settles once it is aborted, as Pi does.
  const interrupter = new RunInterrupter();
  let running = true;
  let aborts = 0;
  interrupter.bind({
    isIdle: () => !running,
    abort: () => {
      aborts += 1;
      running = false;
      setImmediate(() => interrupter.settled(true));
    },
  });

  const hello: Hello = {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    factoryId: "alpha",
    slotId: "lead/1",
    launchId: "launch-1",
    conversationRef: "conv-1",
    hasRecoverableHistory: true,
    mode: "headless",
    tools: [],
  };

  const opened = await openChannel({
    socketPath: channel.socketPath,
    hello,
    heartbeatIntervalMs: 60_000,
    onFrame: (frame, open) => {
      if (frame.type === "interrupt") {interrupter.handle(frame, open);}
    },
  });

  if (!opened.accepted) {throw new Error("hello was not accepted");}

  cleanups.push(() => opened.channel.close());

  const status = () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-02-01T00:00:00.000Z" } });

  const api = await serveManagementApi({
    stateRoot: home,
    status,
    slots: storeSlotsReader(store, home, ["alpha"], slots),
    slotInterrupter: storeSlotInterrupter({ store, factories: ["alpha"], slots, channel }),
  });

  cleanups.push(() => api.close());

  return {
    home,
    store,
    slots,
    launched,
    aborts: () => aborts,
    hellos: () => hellos,
    boundConversation: () => conversations.get("alpha", "lead/1"),
    send: opened.channel.send.bind(opened.channel),
  };
};

test("interrupting a slot aborts its run and keeps the same slot, launch and conversation", async () => {
  const d = await daemonWithWorker();
  const before = await runSlotShow({ json: true, home: d.home, factory: undefined, slot: "lead/1", env });

  const interrupted = await runSlotInterrupt({ json: true, home: d.home, factory: undefined, slot: "lead/1", env });
  expect(interrupted.exitCode).toBe(EXIT_OK);
  expect(JSON.parse(interrupted.stdout)).toMatchObject({
    ok: true,
    result: { launchId: "launch-1", outcome: "aborted", slot: { slotId: "lead/1", condition: "normal", launch: { launchId: "launch-1", endedAt: null } } },
  });
  expect(d.aborts()).toBe(1);

  // The same launch, unended and the only one: nothing was terminated or relaunched.
  const after = await runSlotShow({ json: true, home: d.home, factory: undefined, slot: "lead/1", env });
  expect(JSON.parse(after.stdout)).toEqual(JSON.parse(before.stdout));
  expect(d.launched.map((l) => l.launchId)).toEqual(["launch-1"]);

  // The same conversation on the same channel: no new hello, the binding unchanged, the channel still open.
  expect(d.hellos()).toBe(1);
  expect(d.boundConversation()).toBe("conv-1");
  await d.send({ type: "heartbeat" });

  // A second interrupt reaches the same worker, now idle, without aborting anything.
  const again = await runSlotInterrupt({ json: false, home: d.home, factory: undefined, slot: "lead/1", env });
  expect(again).toEqual({
    exitCode: EXIT_OK,
    stdout: "slot lead/1: no run was active; launch launch-1 and its conversation kept\n",
    stderr: "",
  });
  expect(d.aborts()).toBe(1);
});

test("a slot with no live launch is refused, and nothing is launched into it", async () => {
  const d = await daemonWithWorker();

  const refused = await runSlotInterrupt({ json: true, home: d.home, factory: undefined, slot: "dev/1", env });
  expect(refused.exitCode).toBe(EXIT_REFUSED);
  expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "no_live_launch" } });
  expect(d.launched.map((l) => l.slotId)).toEqual(["lead/1"]);
});

test.each<[string, SlotChannel["interrupt"], string]>([
  ["a worker that never acknowledges", () => new Promise(() => {}), "interrupt_unacknowledged"],
  ["a channel lost before the ack", async (launchId) => { throw new ChannelUnavailableError(launchId, "was lost"); }, "channel_unavailable"],
])("%s is refused with its code, and the launch is left alone", async (_name, interrupt, code) => {
  const d = await daemonWithWorker();
  const interrupter = storeSlotInterrupter({ store: d.store, factories: ["alpha"], slots: d.slots, channel: { interrupt }, ackTimeoutMs: 1 });

  await expect(interrupter.interrupt("lead/1", undefined)).rejects.toMatchObject({ code });
  const shown = await runSlotShow({ json: true, home: d.home, factory: undefined, slot: "lead/1", env });
  expect(JSON.parse(shown.stdout)).toMatchObject({ result: { launches: [{ launchId: "launch-1", endedAt: null }] } });
  expect(d.launched).toHaveLength(1);
});
