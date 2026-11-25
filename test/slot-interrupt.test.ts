// Tier: integration. Real boundaries: the management API socket, the worker channel socket and a
// SQLite store file, driven through the `foundry slot interrupt` core. The Worker Host is a double
// (its launch records), and so is Pi's run control; the real Pi abort is proved by
// packages/extension/e2e/interrupt.e2e.test.ts. The claim: an interrupt through the API aborts the
// run and leaves the same slot on the same launch, bound to the same conversation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Cause, Effect, Exit, Schema, Scope } from "effect";
import {
  ChannelUnavailableError,
  createAssignmentScheduler,
  createTicketService,
  ticketFactoryFrom,
  agentRequestHandler,
  assignmentTicket,
  StoreError,
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
import { FactoryConfig } from "../packages/daemon/src/config/schema.js";
import type { Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import type { LaunchRecord } from "@foundry/host";
import { openChannel, RunInterrupter } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
import { EXIT_OK, EXIT_REFUSED, runSlotInterrupt, runSlotShow, runTicketPause } from "@foundry/cli";

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
const daemonWithWorker = async (holdSettlement = false) => {
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
  let signalAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { signalAbort = resolve; });
  const settle = () => interrupter.settled(true);
  interrupter.bind({
    isIdle: () => !running,
    abort: () => {
      aborts += 1;
      running = false;
      signalAbort();

      if (!holdSettlement) {setImmediate(settle);}
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

  const config = Schema.decodeUnknownSync(FactoryConfig)({
    version: 1, name: "alpha", repository: { source: "/disposable", default_branch: "main" },
    default_production_line: "standard", rooms: { eng: { stations: { lead: {}, dev: {} } } },
    production_lines: { standard: { stages: [{ id: "plan", station: "eng.lead" }] } },
  });

  const ticketOptions = { stateRoot: home, store, factories: () => [ticketFactoryFrom(config)],
    configLoad: () => "load-1", interrupter: storeSlotInterrupter({ store, factories: ["alpha"], slots, channel }),
  };

  const tickets = createTicketService(ticketOptions);
  const assignments = createAssignmentScheduler({ store, slots, factories: [{ factoryId: "alpha", config }] });

  const api = await serveManagementApi({
    stateRoot: home,
    status,
    tickets,
    slots: storeSlotsReader(store, home, ["alpha"], slots),
    slotInterrupter: storeSlotInterrupter({ store, factories: ["alpha"], slots, channel }),
  });

  cleanups.push(() => api.close());

  return {
    home,
    store,
    slots,
    launched,
    tickets,
    ticketOptions,
    assignments,
    aborted,
    settle,
    aborts: () => aborts,
    hellos: () => hellos,
    boundConversation: () => conversations.get("alpha", "lead/1"),
    send: opened.channel.send.bind(opened.channel),
  };
};

test("pausing an assigned ticket waits for settlement, suspends without abandoning records and frees capacity", async () => {
  const d = await daemonWithWorker(true);
  await Effect.runPromise(d.tickets.submit({ title: "First", spec: "Spec" }));
  await Effect.runPromise(d.tickets.submit({ title: "Next", spec: "Spec" }));
  await Effect.runPromise(d.assignments.schedule());
  await Effect.runPromise(d.store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE assignment SET recovery_count = 2, recovery_ceiling = 6 WHERE ticket_number = 1`);
    yield* agentRequestHandler(d.slots, { assignmentTicket })(change, {
      factoryId: "alpha", slotId: "lead/1", launchId: "launch-1", callId: "request-1", tool: "agent_request",
      args: { recipient: "eng.dev", body: "Still need this", timeoutMs: 60_000 },
    });
  })));
  const before = await Effect.runPromise(pauseSnapshot(d.store));
  const slotBefore = await runSlotShow({ json: true, home: d.home, factory: undefined, slot: "lead/1", env });
  const pending = runTicketPause({ json: true, home: d.home, factory: undefined, number: 1, env });
  await d.aborted;
  // An abort request alone is not enough: the worker must acknowledge a settled run.
  expect(await Effect.runPromise(pauseSnapshot(d.store))).toEqual(before);
  expect(await Effect.runPromise(d.assignments.schedule())).toEqual([]);
  const duplicate = await runTicketPause({ json: true, home: d.home, factory: "alpha", number: 1, env });
  expect(JSON.parse(duplicate.stdout)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(d.aborts()).toBe(1);
  d.settle();
  const paused = await pending;
  expect(paused.exitCode).toBe(EXIT_OK);
  const result = JSON.parse(paused.stdout).result;
  expect(result.ticket).toMatchObject({ state: "stage", stage: "plan", status: "paused" });
  expect(result.transitions).toHaveLength(3);
  expect(result.transitions[2]).toMatchObject({ actor: "operator", from: { state: "stage", stage: "plan", status: "assigned" },
    to: { state: "stage", stage: "plan", status: "paused" }, configLoad: "load-1" });
  const after = await Effect.runPromise(pauseSnapshot(d.store));
  expect(after.assignments).toEqual(before.assignments.map((a) => ({ ...a, status: "suspended" })));
  expect(after.requests).toEqual(before.requests);
  expect(after.messages).toEqual(before.messages);
  expect(after.transitions.slice(0, -1)).toEqual(before.transitions);
  expect(after.history.slice(0, -1)).toEqual(before.history);
  expect(after.history.at(-1)).toMatchObject({ kind: "ticket.paused", subject: "1" });
  expect(await Effect.runPromise(d.assignments.schedule())).toMatchObject([{ ticket: 2, slotId: "lead/1" }]);
  expect(await runSlotShow({ json: true, home: d.home, factory: undefined, slot: "lead/1", env })).toEqual(slotBefore);
  expect(d.launched.map((launch) => launch.launchId)).toEqual(["launch-1"]);
  expect(d.boundConversation()).toBe("conv-1");
  expect(d.hellos()).toBe(1);
  expect(d.aborts()).toBe(1);
  const again = await runTicketPause({ json: true, home: d.home, factory: "alpha", number: 1, env });
  expect(JSON.parse(again.stdout)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(d.aborts()).toBe(1); // Must not interrupt the next ticket now using the slot.
});

const pauseSnapshot = (store: Store) => Effect.all({
  assignments: store.read(`SELECT * FROM assignment ORDER BY id`),
  requests: store.read(`SELECT * FROM agent_request ORDER BY id`),
  messages: store.read(`SELECT * FROM message ORDER BY sequence`),
  transitions: store.read(`SELECT * FROM ticket_transition ORDER BY sequence`),
  history: store.read(`SELECT * FROM history ORDER BY sequence`),
  tickets: store.read(`SELECT * FROM ticket ORDER BY number`),
});

test("pause refusals and a failed commit preserve all durable state", async () => {
  const d = await daemonWithWorker();
  await Effect.runPromise(d.tickets.submit({ title: "First", spec: "Spec" }));
  const common = { json: true, home: d.home, factory: undefined, env };

  for (const [number, code] of [[1, "invalid_state"], [99, "ticket_not_found"]] as const) {
    expect(JSON.parse((await runTicketPause({ ...common, number })).stdout)).toMatchObject({ error: { code } });
  }

  expect(d.aborts()).toBe(0);
  await Effect.runPromise(d.assignments.schedule());
  const before = await Effect.runPromise(pauseSnapshot(d.store));

  // Use the same production interrupter's error translation, not a fabricated ticket refusal.
  const disconnected = createTicketService({ ...d.ticketOptions, interrupter: storeSlotInterrupter({
    store: d.store, factories: ["alpha"], slots: d.slots,
    channel: { interrupt: async () => { throw new ChannelUnavailableError("launch-1", "lost"); } },
  }) });

  const refused = await Effect.runPromise(Effect.exit(disconnected.pause(undefined, 1)));
  expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toMatchObject({ code: "channel_unavailable" });
  expect(await Effect.runPromise(pauseSnapshot(d.store))).toEqual(before);

  const failing: Store = { ...d.store, change: (body) => d.store.change((change) =>
    Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failed" })))),
  };

  const service = createTicketService({ ...d.ticketOptions, store: failing });
  expect(Exit.isFailure(await Effect.runPromise(Effect.exit(service.pause(undefined, 1))))).toBe(true);
  expect(await Effect.runPromise(pauseSnapshot(d.store))).toEqual(before);
  expect(d.aborts()).toBe(1);
});

test("an assignment replaced during interruption is not suspended and gets no pause transition", async () => {
  const d = await daemonWithWorker();
  await Effect.runPromise(d.tickets.submit({ title: "First", spec: "Spec" }));
  await Effect.runPromise(d.assignments.schedule());
  let successor: unknown;

  const service = createTicketService({ ...d.ticketOptions, interrupter: {
    interrupt: async (slot, factory) => {
      const result = await d.ticketOptions.interrupter.interrupt(slot, factory);
      await Effect.runPromise(d.store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1, end_reason = 'abandoned'`);
        yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
          SELECT 'replacement', factory_id, ticket_number, stage, slot_id, 'active', recovery_ceiling, 2, context_message FROM assignment`);
        yield* change.recordHistory({ factoryId: "alpha", kind: "fixture.replaced", subject: "1" });
      })));
      successor = await Effect.runPromise(pauseSnapshot(d.store));

      return result;
    },
  } });

  const result = await Effect.runPromise(Effect.exit(service.pause(undefined, 1)));
  expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ code: "invalid_state" });
  expect(await Effect.runPromise(pauseSnapshot(d.store))).toEqual(successor);
});

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
