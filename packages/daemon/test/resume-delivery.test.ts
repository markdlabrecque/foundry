// Integration tier: disposable SQLite and the real delivery/reconciliation services prove
// notice replacement and assignment eligibility. A recording channel avoids another socket test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import {
  acknowledgeMessage, composeResumeNotice, createAssignmentScheduler, createMessageDelivery,
  createReconciler, createTicketService, openSlotGate, openStore, planSlots, raiseHold,
  taskTransitionHandler, ticketFactoryFrom,
} from "@foundry/daemon";
import type { Store, TicketService } from "@foundry/daemon";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame } from "@foundry/protocol";
import { FactoryConfig } from "../src/config/schema.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }, { id: "review", station: "floor.worker" }] } },
});

const slots = planSlots("shop", [{ address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 1, isolation: "none" }]);

const slot = { factoryId: "shop", slotId: "worker/1", launchId: "launch" };
let root: string;
let scope: Scope.Closeable;
let store: Store;
let tickets: TicketService;
let assignmentId: string;
let noticeId: string;
let delivery: ReturnType<typeof createMessageDelivery>;
const frames: Array<DaemonFrame> = [];
const errors: Array<unknown> = [];

const refresh = (message: string) => Effect.runPromise(store.change((change) => composeResumeNotice(change, {
  assignmentId, factoryId: "shop", ticket: 1, stage: "plan", slotId: slot.slotId, recipient: "floor.worker", message,
})));

const notices = () => Effect.runPromise(store.read<{ id: string; body: string; status: string }>(
  `SELECT id, body, status FROM message WHERE kind = 'resume_notice' ORDER BY sequence`,
));

const attach = () => { delivery.attach(slot, { send: async (frame) => { frames.push(frame); } }); };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "foundry-resume-delivery-"));
  scope = await Effect.runPromise(Scope.make());
  store = await Effect.runPromise(openStore({ filename: join(root, "state.db") }).pipe(Scope.provide(scope)));
  frames.length = 0;
  errors.length = 0;
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', 'worker/1', 'worker', 1, 'normal')`);
    yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'slot' });
  })));
  tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)],
    interrupter: { interrupt: async () => ({ launchId: slot.launchId, outcome: 'idle',
      slot: { factoryId: slot.factoryId, slotId: slot.slotId, station: 'floor.worker', ordinal: 1,
        condition: 'normal', freezeCause: null, launch: null } }) } });
  await Effect.runPromise(tickets.submit({ title: "Notice delivery", spec: "disposable" }));
  const scheduler = createAssignmentScheduler({ store, slots, factories: [{ factoryId: 'shop', config }] });
  const [assignment] = await Effect.runPromise(scheduler.schedule());

  if (assignment === undefined) {throw new Error('missing fixture assignment');}

  assignmentId = assignment.id;
  await Effect.runPromise(tickets.pause('shop', 1));
  await Effect.runPromise(tickets.resume('shop', 1, 'Original interruption'));
  await Effect.runPromise(scheduler.schedule());
  const [notice] = await notices();

  if (notice === undefined) {throw new Error('missing fixture notice');}

  noticeId = notice.id;
  delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (error) => errors.push(error) });
});

afterEach(async () => {
  await delivery?.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(root, { recursive: true, force: true });
});

test('sent notice refresh preserves wire payload and publishes latest content only after its receipt', async () => {
  attach();
  await delivery.idle();
  expect(frames).toHaveLength(1);
  const original = (await notices())[0];
  await refresh('Second interruption');
  await refresh('Latest interruption');
  await delivery.idle();
  expect(frames).toHaveLength(1);
  expect(await notices()).toEqual([original]);
  expect(await Effect.runPromise(store.read(`SELECT pending_body FROM resume_notice WHERE message_id = ?`, [noticeId])))
    .toEqual([{ pending_body: expect.stringContaining('Latest interruption') }]);
  expect(await Effect.runPromise(acknowledgeMessage(store, slot, noticeId))).toBe(true);
  await delivery.idle();
  const saved = await notices();
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual({ ...original, status: 'acknowledged' });
  expect(saved[1]).toMatchObject({ status: 'sent', body: expect.stringContaining('Latest interruption') });
  expect(frames[1]).toMatchObject({ type: 'message', id: saved[1]?.id, body: saved[1]?.body });
  expect(await Effect.runPromise(acknowledgeMessage(store, slot, noticeId))).toBe(false);
  expect(saved.filter((row) => row.status === 'sent')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('proven absent idle copy is replaced without mutating or replaying its attempted content', async () => {
  attach();
  await delivery.idle();
  const original = (await notices())[0];
  await refresh('Replacement after reconciliation');
  await Effect.runPromise(raiseHold(store, { factoryId: 'shop', kind: 'stuck_worker', subject: noticeId,
    evidence: { messageId: noticeId } }));
  const reconciler = createReconciler(store);
  await reconciler.reconcile(slot, { type: 'hello', protocolVersion: PROTOCOL_VERSION, ...slot,
    conversationRef: 'conversation', hasRecoverableHistory: true, mode: 'headless', tools: [] }, {
    send: async (frame) => {
      if (frame.type === 'reconcile') {
        reconciler.receive(slot, { type: 'reconciliation_answer', requestId: frame.requestId,
          answers: frame.ids.map((id) => ({ id, status: 'absent' })), lifecycle: 'idle' });
      }
    },
  });
  await delivery.idle();
  const saved = await notices();
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual({ ...original, status: 'dropped' });
  expect(saved[1]).toMatchObject({ status: 'sent', body: expect.stringContaining('Replacement after reconciliation') });
  expect(await Effect.runPromise(store.read(`SELECT retired_at FROM message_attempt WHERE message_id = ?`, [noticeId])))
    .toEqual([{ retired_at: expect.any(Number) }]);
  expect(await Effect.runPromise(store.read(`SELECT state FROM operator_hold WHERE subject = ?`, [noticeId])))
    .toEqual([{ state: 'cleared' }]);
  expect(frames.filter((frame) => frame.type === 'message' && frame.id === noticeId)).toHaveLength(1);
  expect(frames[1]).toMatchObject({ type: 'message', id: saved[1]?.id, body: saved[1]?.body });
  expect(errors).toEqual([]);
});

test('rearmed attempted notice refresh replaces its ID and retains the original attempted payload', async () => {
  attach();
  await delivery.idle();
  const original = (await notices())[0];
  // Model the durable re-arm after an operator slot reset, before the delivery pump can run.
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE message SET status = 'bound' WHERE id = ?`, [noticeId]);
    yield* composeResumeNotice(change, { assignmentId, factoryId: 'shop', ticket: 1, stage: 'plan',
      slotId: slot.slotId, recipient: 'floor.worker', message: 'Reset continuation' });
  })));
  await delivery.idle();
  const saved = await notices();
  expect(saved[0]).toEqual({ ...original, status: 'dropped' });
  expect(saved[1]).toMatchObject({ status: 'sent', body: expect.stringContaining('Reset continuation') });
  expect(frames.filter((frame) => frame.type === 'message' && frame.id === noticeId)).toHaveLength(1);
  expect(frames[1]).toMatchObject({ type: 'message', id: saved[1]?.id, body: saved[1]?.body });
  expect(errors).toEqual([]);
});

test.each(['pause', 'blocked', 'done'])('%s before first delivery invalidates the old continuation', async (action) => {
  if (action === 'pause') {
    await Effect.runPromise(tickets.pause('shop', 1));
  } else {
    await Effect.runPromise(store.change((change) => taskTransitionHandler({ factories: [{ factoryId: 'shop', config }] })(change, {
      ...slot, callId: 'outcome', tool: 'task_transition', args: { assignmentId, outcome: action, reason: 'accepted outcome', evidence: [] },
    })));
  }

  expect(await notices()).toMatchObject([{ id: noticeId, status: 'dropped' }]);
  attach();
  await delivery.idle();
  expect(frames).toEqual([]);
  expect(await Effect.runPromise(store.read(`SELECT * FROM message_attempt`))).toEqual([]);
  expect(errors).toEqual([]);
});

test('ending an assignment with a sent notice cancels deferred replacement even when its receipt arrives later', async () => {
  attach();
  await delivery.idle();
  await refresh('This replacement must not continue paused work');
  await Effect.runPromise(tickets.pause('shop', 1));
  expect(await Effect.runPromise(acknowledgeMessage(store, slot, noticeId))).toBe(true);
  await delivery.idle();
  expect(frames).toHaveLength(1);
  expect(await notices()).toMatchObject([{ id: noticeId, status: 'acknowledged' }]);
  expect(errors).toEqual([]);
});
