// Tier: integration. Disposable SQLite + real channel prove delivery and receipt wiring.
// Pi's policy and recoverable-history boundary is covered in extension/test/messages.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { acknowledgeMessage, createMessageDelivery, createPrimer, openSlotGate, openStore, raiseHold, startChannelServer } from "@foundry/daemon";
import type { ChannelServer, Store } from "@foundry/daemon";
import { openChannel } from "@foundry/extension";
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
