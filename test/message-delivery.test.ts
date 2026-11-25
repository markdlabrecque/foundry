// Tier: integration. Disposable SQLite + real channel prove delivery and receipt wiring.
// Pi's policy and recoverable-history boundary is covered in extension/test/messages.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { acknowledgeMessage, createMessageDelivery, createPrimer, createReconciler, openSlotGate, openStore, raiseHold, startChannelServer } from "@foundry/daemon";
import type { ChannelServer, Store } from "@foundry/daemon";
import { createConversationAdapter, openChannel, receiveDaemonFrames } from "@foundry/extension";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { startFauxSession } from "@foundry/testkit";
import type { OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame, Hello } from "@foundry/protocol";

const slot = { factoryId: "factory", slotId: "builder/1", launchId: "launch" };

const hello: Hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, ...slot,
  conversationRef: "conversation", hasRecoverableHistory: true, mode: "headless", tools: [] };

let dir: string;
let scope: Scope.Closeable;
let store: Store;
let delivery: ReturnType<typeof createMessageDelivery>;
let server: ChannelServer | undefined;
let session: AgentSession | undefined;
const clients: Array<OpenChannel> = [];
const errors: Array<unknown> = [];
const noop = () => {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-delivery-"));
  scope = await Effect.runPromise(Scope.make());
  store = await Effect.runPromise(openStore({ filename: join(dir, "state.db") }).pipe(Scope.provide(scope)));
  errors.length = 0;
  delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => errors.push(cause) });
});

afterEach(async () => {
  for (const client of clients.splice(0)) {client.close();}

  await server?.close();
  server = undefined;
  await delivery.stop();
  session?.dispose();
  session = undefined;
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await rm(dir, { recursive: true, force: true });
});

const seed = async (sequence: number, deliveryPolicy = "after_turn", boundSlot = slot.slotId) => {
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`INSERT INTO message
      (id, factory_id, sequence, sender_slot, recipient, body, delivery, kind, status, accepted_at, bound_slot, bound_at)
      VALUES (?, ?, ?, 'sender/1', 'eng.builder', ?, ?, 'ordinary', 'bound', 1, ?, 2)`,
    [`m${sequence}`, slot.factoryId, sequence, `body ${sequence}`, deliveryPolicy, boundSlot]);
    yield* change.recordHistory({ factoryId: slot.factoryId, kind: "fixture.bound", subject: `m${sequence}` });
  })));
};

const state = () => Effect.runPromise(store.read(`SELECT id, status, acknowledged_at FROM message ORDER BY sequence`));
const attempts = () => Effect.runPromise(store.read(`SELECT message_id, acknowledged_at FROM message_attempt ORDER BY sent_at, rowid`));

test("bound messages go in acceptance order without waiting for receipts; commits never reinject and reconnect never blindly retries", async () => {
  await seed(2);
  await seed(1, "when_idle");
  await seed(3, "after_turn", "builder/2");
  const received: Array<DaemonFrame> = [];
  let seenTwo!: () => void;
  const two = new Promise<void>((resolve) => { seenTwo = resolve; });
  let acknowledged!: (result: boolean) => void;
  const receipt = new Promise<boolean>((resolve) => { acknowledged = resolve; });

  const primer = createPrimer({ store, primeRequest: () => ({ address: "eng.builder", slotId: slot.slotId,
    isolation: "worktree", instructions: [], knowledgeRoot: join(dir, "knowledge"), baseDir: dir }) });

  let attached = noop;

  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async () => ({ accepted: true, slot }) },
    onAccepted: (claimed, greeting, connection) => {
      const primed = primer.prime(claimed, greeting, connection);
      void primed.outcome.then(() => { delivery.attach(claimed, primed.connection); attached(); });
    },
    onFrame: (claimed, frame) => {
      if (frame.type === "receipt") {void Effect.runPromise(acknowledgeMessage(store, claimed, frame.id)).then(acknowledged);}
    },
  });

  const opened = await openChannel({ socketPath: server.socketPath, hello, onFrame: (frame) => {
    if (frame.type !== "message") {return;}

    received.push(frame);

    if (received.length === 2) {seenTwo();}
  } });

  if (!opened.accepted) {throw new Error("fixture hello refused");}

  clients.push(opened.channel);
  await two;
  await delivery.idle();
  expect(received).toEqual([
    { type: "message", id: "m1", body: "body 1", delivery: "when_idle" },
    { type: "message", id: "m2", body: "body 2", delivery: "after_turn" },
  ]);
  expect(await state()).toEqual([
    { id: "m1", status: "sent", acknowledged_at: null },
    { id: "m2", status: "sent", acknowledged_at: null },
    { id: "m3", status: "bound", acknowledged_at: null },
  ]);
  expect(await attempts()).toHaveLength(2);
  await opened.channel.send({ type: "receipt", id: "m2" });
  expect(await receipt).toBe(true);
  await delivery.idle();
  expect(await state()).toMatchObject([{ status: "sent" }, { status: "acknowledged", acknowledged_at: expect.any(Number) }, { status: "bound" }]);
  expect(await attempts()).toMatchObject([{ acknowledged_at: null }, { acknowledged_at: expect.any(Number) }]);
  expect(await Effect.runPromise(acknowledgeMessage(store, slot, "m2"))).toBe(false);
  expect(await Effect.runPromise(acknowledgeMessage(store, { ...slot, slotId: "builder/2" }, "m1"))).toBe(false);
  expect(await Effect.runPromise(acknowledgeMessage(store, { ...slot, launchId: "other" }, "m1"))).toBe(false);
  expect(await Effect.runPromise(acknowledgeMessage(store, slot, "m3"))).toBe(false);
  opened.channel.close();
  await opened.channel.closed;
  // Synchronize the daemon's close as well, not just the client's local socket.
  await server.close();
  server = undefined;
  await delivery.idle();
  await seed(4);
  await delivery.idle();
  expect(await attempts()).toHaveLength(2);
  expect(await state()).toMatchObject([{ status: "sent" }, { status: "acknowledged" }, { status: "bound" }, { status: "bound" }]);
  const reattached = new Promise<void>((resolve) => { attached = resolve; });
  server = await startChannelServer({ socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async () => ({ accepted: true, slot }) },
    onAccepted: (claimed, greeting, connection) => {
      const primed = primer.prime(claimed, greeting, connection);
      void primed.outcome.then(() => { delivery.attach(claimed, primed.connection); attached(); });
    } });
  let delivered!: () => void;
  const newMessage = new Promise<void>((resolve) => { delivered = resolve; });

  const reconnect = await openChannel({ socketPath: server.socketPath, hello, onFrame: (frame) => {
    received.push(frame);

    if (frame.type === "message" && frame.id === "m4") {delivered();}
  } });

  if (!reconnect.accepted) {throw new Error("fixture reconnect refused");}

  clients.push(reconnect.channel);
  await reattached;
  await newMessage;
  await delivery.idle();
  // Database attempt cardinality proves no extra writes without a negative socket timeout.
  expect(await attempts()).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("reconnect compares a lost receipt and a held copy against real Pi without reinjecting either", async () => {
  let dispatch: ReturnType<typeof receiveDaemonFrames> | undefined;
  let settled!: () => void;
  const completed = new Promise<void>((resolve) => { settled = resolve; });
  session = await startFauxSession({ root: dir, extensionFactories: [(pi) => {
    const adapter = createConversationAdapter(pi, { onReceipt: noop }); // Deliberately lose every receipt.
    dispatch = receiveDaemonFrames({ adapter, interrupter: { handle: noop, handleDrain: noop } });
    pi.on("agent_settled", () => settled());
  }] });
  await seed(1);
  await seed(2, "when_idle");
  const reconciler = createReconciler(store);

  const primer = createPrimer({ store, primeRequest: () => ({ address: "eng.builder", slotId: slot.slotId,
    isolation: "worktree", instructions: [], knowledgeRoot: join(dir, "knowledge"), baseDir: dir }) });

  let attached!: () => void;
  let attachment = new Promise<void>((resolve) => { attached = resolve; });
  const comparisons: Array<Awaited<ReturnType<typeof reconciler.reconcile>>> = [];
  const frames: Array<DaemonFrame> = [];
  let delivered!: () => void;
  const newWork = new Promise<void>((resolve) => { delivered = resolve; });

  const start = () => startChannelServer({ socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async () => ({ accepted: true as const, slot }) },
    onAccepted: (claimed, greeting, connection) => {
      void reconciler.reconcile(claimed, greeting, connection).then(async (comparison) => {
        comparisons.push(comparison);
        const primed = primer.prime(claimed, greeting, connection);
        await primed.outcome;
        delivery.attach(claimed, primed.connection);
        attached();
      }).catch((cause: unknown) => errors.push(cause));
    },
    onFrame: (claimed, frame) => {
      if (frame.type === "reconciliation_answer") {reconciler.receive(claimed, frame);}
    },
  });

  const connect = async () => {
    const opened = await openChannel({ socketPath: join(dir, "channel.sock"), hello, onFrame: (frame, channel) => {
      frames.push(frame);
      dispatch?.(frame, channel);

      if (frame.type === "message" && frame.id === "m3") {delivered();}
    } });

    if (!opened.accepted) {throw new Error("fixture hello refused");}

    clients.push(opened.channel);

    return opened.channel;
  };

  server = await start();
  const first = await connect();
  await attachment;
  await completed;
  await delivery.idle();
  first.close();
  await server.close();
  server = undefined;
  await seed(3);
  attachment = new Promise<void>((resolve) => { attached = resolve; });
  server = await start();
  await connect();
  await attachment;
  await delivery.idle();
  await newWork;
  expect(comparisons[1]).toMatchObject({ history: expect.arrayContaining(["m1"]), pending: ["m2"], absent: [] });
  expect(comparisons[1]?.history).toHaveLength(2); // Previously sent prime is recoverable too.
  expect(await state()).toMatchObject([{ status: "acknowledged" }, { status: "sent" }, { status: "sent" }]);
  expect(await Effect.runPromise(store.read(`SELECT acknowledged_at FROM prime`))).toEqual([{ acknowledged_at: expect.any(Number) }]);
  expect(await attempts()).toHaveLength(3);
  expect(frames.filter((frame) => frame.type === "message" && frame.id === "m1")).toHaveLength(1);
  expect(frames.filter((frame) => frame.type === "message" && frame.id === "m2")).toHaveLength(1);
  expect(frames.filter((frame) => frame.type === "prime")).toHaveLength(1);
  expect(frames.findIndex((frame) => frame.type === "reconcile")).toBeLessThan(
    frames.findIndex((frame) => frame.type === "message" && frame.id === "m3"));
  expect(errors).toEqual([]);
});

test("replacement-launch history acknowledges old attempts; invalid answers, absence and closure never replay", async () => {
  await seed(1);
  await seed(2);
  delivery.attach(slot, { send: async () => {} });
  await delivery.idle();
  const reconciler = createReconciler(store);
  let requested!: () => void;
  const sent = new Promise<void>((resolve) => { requested = resolve; });
  let requestId = "";
  let closed!: () => void;
  const ended = new Promise<void>((resolve) => { closed = resolve; });

  const replacement = { ...slot, launchId: "replacement" };
  expect(await Effect.runPromise(acknowledgeMessage(store, replacement, "m2"))).toBe(false);

  const comparison = reconciler.reconcile(replacement, { ...hello, launchId: replacement.launchId }, { closed: ended, send: async (frame) => {
    if (frame.type !== "reconcile") {throw new Error("expected comparison");}

    requestId = frame.requestId;
    requested();
  } });

  await sent;

  const valid = { type: "reconciliation_answer" as const, requestId,
    answers: [{ id: "m1", status: "absent" as const }, { id: "m2", status: "history" as const }] };

  reconciler.receive(slot, valid);
  reconciler.receive({ ...replacement, slotId: "wrong" }, valid);
  reconciler.receive({ ...replacement, factoryId: "wrong" }, valid);
  reconciler.receive(replacement, { ...valid, answers: [] });
  reconciler.receive(replacement, { ...valid, answers: [{ id: "unknown", status: "history" }, valid.answers[0]!] });
  reconciler.receive(replacement, { ...valid, answers: [valid.answers[0]!, valid.answers[0]!] });
  reconciler.receive(replacement, valid);
  expect(await comparison).toEqual({ history: ["m2"], pending: [], absent: ["m1"] });
  expect(await state()).toEqual([{ id: "m1", status: "sent", acknowledged_at: null },
    { id: "m2", status: "acknowledged", acknowledged_at: expect.any(Number) }]);
  expect(await attempts()).toEqual([{ message_id: "m1", acknowledged_at: null },
    { message_id: "m2", acknowledged_at: expect.any(Number) }]);
  expect(await Effect.runPromise(store.read(`SELECT subject FROM history WHERE kind = 'message.acknowledged'`))).toEqual([{ subject: "m2" }]);
  const interrupted = reconciler.reconcile(slot, hello, { closed: ended, send: async () => { closed(); } });
  await expect(interrupted).rejects.toThrow("channel ended during reconciliation");
  let staleRequest = "";
  await expect(reconciler.reconcile(slot, hello, { send: async (frame) => {
    if (frame.type === "reconcile") {staleRequest = frame.requestId;}

    throw new Error("fixture send failed");
  } })).rejects.toThrow("fixture send failed");
  reconciler.receive(slot, { type: "reconciliation_answer", requestId: staleRequest, answers: [{ id: "m1", status: "history" }] });

  const later = await reconciler.reconcile(slot, hello, { send: async (frame) => {
    if (frame.type === "reconcile") {
      reconciler.receive(slot, { type: "reconciliation_answer", requestId: frame.requestId, answers: [{ id: "m1", status: "pending" }] });
    }
  } });

  expect(later).toEqual({ history: [], pending: ["m1"], absent: [] });
});

test("a failed channel write leaves a recorded unacknowledged attempt and never retries on that connection", async () => {
  await seed(1);
  let sends = 0;
  delivery.attach(slot, { send: async () => {
    sends += 1;
    expect(await state()).toMatchObject([{ status: "sent", acknowledged_at: null }]);
    expect(await attempts()).toEqual([{ message_id: "m1", acknowledged_at: null }]);
    throw new Error("fixture write failure");
  } });
  await delivery.idle();
  await seed(2);
  await delivery.idle();
  expect(sends).toBe(1);
  expect(errors).toHaveLength(1);
  expect(await state()).toMatchObject([{ status: "sent", acknowledged_at: null }, { status: "bound" }]);
});

test.each([
  { name: "same launch settled absent", replacement: false, old: "missing", lifecycle: "idle", restored: true, final: "absent", retry: true, recheck: false },
  { name: "same launch unknown lifecycle", replacement: false, old: "missing", lifecycle: "unknown", restored: true, final: "absent", retry: false, recheck: false },
  { name: "working then idle absent", replacement: false, old: "missing", lifecycle: "working", restored: true, final: "absent", retry: true, recheck: true },
  { name: "working then history", replacement: false, old: "missing", lifecycle: "working", restored: true, final: "history", retry: false, recheck: true },
  { name: "working then pending", replacement: false, old: "missing", lifecycle: "working", restored: true, final: "pending", retry: false, recheck: true },
  { name: "replacement confirmed gone", replacement: true, old: "ended", lifecycle: "working", restored: true, final: "absent", retry: true, recheck: false },
  { name: "replacement old still live", replacement: true, old: "live", lifecycle: "idle", restored: true, final: "absent", retry: false, recheck: false },
  { name: "replacement old unknown", replacement: true, old: "missing", lifecycle: "idle", restored: true, final: "absent", retry: false, recheck: false },
  { name: "replacement history not restored", replacement: true, old: "ended", lifecycle: "idle", restored: false, final: "absent", retry: false, recheck: false },
] as const)("retry gate: $name", async ({ replacement, old, lifecycle, restored, final, retry, recheck }) => {
  await seed(1);
  delivery.attach(slot, { send: async () => {} });
  await delivery.idle();
  await delivery.stop();

  if (old !== "missing") {
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, ?, 'eng.builder', 1, 'normal')`, [slot.factoryId, slot.slotId]);
      yield* change.query(`INSERT INTO launch (launch_id, factory_id, slot_id, boot_id, pid, started_at, origin, ended_at, end_reason)
        VALUES (?, ?, ?, 'boot', 42, 1, 'started', ?, ?)`, [slot.launchId, slot.factoryId, slot.slotId, old === "ended" ? 2 : null, old === "ended" ? "exited" : null]);
      yield* change.recordHistory({ factoryId: slot.factoryId, kind: "fixture.launch", subject: slot.launchId });
    })));
  }

  const claimed = replacement ? { ...slot, launchId: "replacement" } : slot;
  const reconciler = createReconciler(store);
  const requests: Array<DaemonFrame> = [];

  const result = await reconciler.reconcile(claimed, { ...hello, launchId: claimed.launchId, hasRecoverableHistory: restored }, { send: async (frame) => {
    requests.push(frame);

    if (frame.type !== "reconcile") {throw new Error("expected comparison");}

    reconciler.receive(claimed, { type: "reconciliation_answer", requestId: frame.requestId,
      lifecycle: frame.whenIdle ? "idle" : lifecycle,
      answers: [{ id: "m1", status: frame.whenIdle ? final : "absent" }] });
  } });

  expect(requests).toHaveLength(recheck ? 2 : 1);

  if (recheck) {expect(requests[1]).toMatchObject({ whenIdle: true, ids: ["m1"] });}

  expect(result[recheck ? final : "absent"]).toEqual(["m1"]);
  expect(await state()).toMatchObject([{ status: retry ? "bound" : final === "history" ? "acknowledged" : "sent" }]);
  expect(await attempts()).toHaveLength(1);

  if (retry) {
    delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => errors.push(cause) });
    const frames: Array<DaemonFrame> = [];
    delivery.attach(claimed, { send: async (frame) => { frames.push(frame); } });
    await delivery.idle();
    expect(frames).toEqual([{ type: "message", id: "m1", body: "body 1", delivery: "after_turn" }]);
    expect(await attempts()).toHaveLength(2);
    expect(await state()).toMatchObject([{ status: "sent" }]);
  }

  expect(errors).toEqual([]);
});

test("receipt, attempt and stuck-worker hold clear together, and roll back together on failure", async () => {
  await seed(1);
  delivery.attach(slot, { send: async () => {} });
  await delivery.idle();
  await Effect.runPromise(raiseHold(store, { factoryId: slot.factoryId, kind: "stuck_worker", subject: "m1", evidence: { slot: slot.slotId } }));
  await delivery.idle();
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`CREATE TRIGGER refuse_receipt BEFORE INSERT ON history WHEN NEW.kind = 'message.acknowledged'
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    yield* change.recordHistory({ factoryId: slot.factoryId, kind: "fixture.trigger", subject: "m1" });
  })));
  await expect(Effect.runPromise(acknowledgeMessage(store, slot, "m1"))).rejects.toThrow();
  expect(await state()).toEqual([{ id: "m1", status: "sent", acknowledged_at: null }]);
  expect(await attempts()).toEqual([{ message_id: "m1", acknowledged_at: null }]);
  expect(await Effect.runPromise(store.read(`SELECT state FROM operator_hold`))).toEqual([{ state: "open" }]);
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`DROP TRIGGER refuse_receipt`);
    yield* change.recordHistory({ factoryId: slot.factoryId, kind: "fixture.trigger_removed", subject: "m1" });
  })));
  expect(await Effect.runPromise(acknowledgeMessage(store, slot, "m1"))).toBe(true);
  expect(await Effect.runPromise(store.read(`SELECT state FROM operator_hold`))).toEqual([{ state: "cleared" }]);
  expect(await state()).toMatchObject([{ status: "acknowledged" }]);
  expect(await attempts()).toMatchObject([{ acknowledged_at: expect.any(Number) }]);
});
