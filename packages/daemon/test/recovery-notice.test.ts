// Integration tier: disposable SQLite and a recording channel prove recovery ordering,
// active-assignment eligibility and the shared composer's durable deduplication.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Predicate, Schema, Scope } from "effect";
import {
  acknowledgePrime, createAssignmentScheduler, createMessageDelivery,
  createPrimer, createReconciler, createTicketService, openSlotGate, openStore, planSlots,
  recordPrime, taskTransitionHandler, ticketFactoryFrom,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame, ReconciliationAnswer } from "@foundry/protocol";
import { FactoryConfig } from "../src/config/schema.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }, { id: "review", station: "floor.worker" }] } },
});

const slots = planSlots("shop", [{ address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 1, isolation: "none" }]);

const slot = { factoryId: "shop", slotId: "worker/1", launchId: "replacement" };

const hello = { type: "hello" as const, protocolVersion: PROTOCOL_VERSION, ...slot,
  conversationRef: "conversation", hasRecoverableHistory: true, mode: "headless" as const, tools: [] };

let root: string;
let scope: Scope.Closeable;
let store: Store;
let assignmentId: string;
let delivery: ReturnType<typeof createMessageDelivery>;
const frames: Array<DaemonFrame> = [];
const errors: Array<unknown> = [];

const notices = () => Effect.runPromise(store.read<{ id: string; body: string; status: string }>(
  `SELECT id, body, status FROM message WHERE kind = 'resume_notice' ORDER BY sequence`,
));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "foundry-recovery-notice-"));
  scope = await Effect.runPromise(Scope.make());
  store = await Effect.runPromise(openStore({ filename: join(root, "state.db") }).pipe(Scope.provide(scope)));
  frames.length = 0;
  errors.length = 0;
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition, current_launch)
      VALUES ('shop', 'worker/1', 'floor.worker', 1, 'normal', 'replacement')`);
    yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'slot' });
  })));
  const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
  await Effect.runPromise(tickets.submit({ title: 'Interrupted assignment', spec: 'disposable' }));
  const [assignment] = await Effect.runPromise(createAssignmentScheduler({ store, slots, factories: [{ factoryId: 'shop', config }] }).schedule());

  if (assignment === undefined) {throw new Error('missing assignment');}

  assignmentId = assignment.id;
  // The original assignment context was already consumed before the worker died.
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE message SET status = 'acknowledged' WHERE id = ?`, [assignment.contextMessage]);
    yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'context' });
  })));
  await Effect.runPromise(recordPrime(store, { ...slot, launchId: 'old-launch', id: 'old-prime',
    conversationRef: hello.conversationRef, situation: 'fresh', parts: [] }));
  delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (error) => errors.push(error) });
});

afterEach(async () => {
  await delivery?.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(root, { recursive: true, force: true });
});

const recover = async (lifecycle: ReconciliationAnswer['lifecycle'] | null = 'idle', beforeSnapshot?: () => Promise<void>, recoverable = true) => {
  const reconciler = createReconciler(store);

  const connection = { send: async (frame: DaemonFrame) => {
    frames.push(frame);

    if (frame.type === 'reconcile') {
      if (frame.ids.length === 0) {await beforeSnapshot?.();}

      const response: ReconciliationAnswer = { type: 'reconciliation_answer', requestId: frame.requestId,
        answers: frame.ids.map((id) => ({ id, status: id === 'old-prime' ? 'history' : 'pending' })) };

      reconciler.receive(slot, lifecycle === null || lifecycle === undefined ? response : { ...response, lifecycle });
    }
  } };

  const comparison = await reconciler.reconcile(slot, hello, connection);

  const primer = createPrimer({ store, primeRequest: () => ({ address: 'floor.worker', slotId: slot.slotId,
    isolation: 'none', instructions: [], knowledgeRoot: join(root, 'knowledge'), baseDir: root }) });

  const primed = primer.prime(slot, { ...hello, hasRecoverableHistory: recoverable }, connection);
  const outcome = await primed.outcome;

  if (Predicate.isTagged(outcome, 'Sent') || Predicate.isTagged(outcome, 'Reconnect')) {
    await reconciler.resumeAssignment(slot, primed.connection, comparison.interruptedAssignmentId);
    delivery.attach(slot, primed.connection);
    await delivery.idle();
  }

  return outcome;
};

test('reconciles lost prime receipt, primes recovery, then resumes active idle work once', async () => {
  await recover();
  const [notice] = await notices();
  expect(notice).toMatchObject({ status: 'sent', body: expect.stringContaining(`Assignment: ${assignmentId}`) });
  expect(notice?.body).toContain('Ticket 1\nStage: plan');
  expect(notice?.body).toContain('last tool call may or may not have completed');
  expect(notice?.body).toContain('Inspect the worktree and ticket directory');
  expect(notice?.body).toContain('Reported outcome: none\nOpen requests: none\nOpen delegations: none');
  expect(frames.map((frame) => frame.type)).toEqual(['reconcile', 'prime', 'reconcile', 'message']);
  expect(frames[1]).toMatchObject({ type: 'prime', text: expect.stringContaining('Situation: recovery') });
  expect(frames[3]).toMatchObject({ type: 'message', id: notice?.id, delivery: 'after_turn' });
  await recover();
  expect((await notices()).filter((row) => row.status === 'sent')).toEqual([notice]);
  expect(frames.filter((frame) => frame.type === 'message')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test.each(['working', 'unknown', null] as const)('no notice without positive idle evidence (%s)', async (lifecycle) => {
  await recover(lifecycle);
  expect(await notices()).toEqual([]);
  expect(frames.filter((frame) => frame.type === 'message')).toEqual([]);
});

test.each(['done', 'blocked'] as const)('committed %s during reconciliation is honoured without a notice', async (outcome) => {
  await recover('idle', async () => {
    await Effect.runPromise(store.change((change) => taskTransitionHandler({ factories: [{ factoryId: 'shop', config }] })(change, {
      ...slot, callId: 'committed-outcome', tool: 'task_transition', args: { assignmentId, outcome, reason: 'accepted before recovery', evidence: [] },
    })));
  });
  expect(await notices()).toEqual([]);
  expect(await Effect.runPromise(store.read(`SELECT status FROM assignment WHERE id = ?`, [assignmentId])))
    .toEqual([{ status: outcome === 'blocked' ? 'suspended' : 'ended' }]);
  expect(frames.filter((frame) => frame.type === 'message')).toEqual([]);
});

test.each(['vacant', 'suspended', 'frozen', 'stale launch'] as const)('no continuation for %s slot', async (condition) => {
  await recover('idle', async () => {
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      if (condition === 'vacant' || condition === 'suspended') {
        yield* change.query(`UPDATE assignment SET status = ?, ended_at = ? WHERE id = ?`,
          [condition === 'vacant' ? 'ended' : 'suspended', condition === 'vacant' ? 1 : null, assignmentId]);
      } else if (condition === 'frozen') {
        yield* change.query(`UPDATE slot SET condition = 'frozen'`);
      } else {
        yield* change.query(`UPDATE slot SET current_launch = 'newer-launch'`);
      }

      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'ineligible' });
    })));
  });
  expect(await notices()).toEqual([]);
});

test('lost acknowledged history never reaches the notice comparison', async () => {
  await Effect.runPromise(acknowledgePrime(store, { ...slot, id: 'old-prime' }));
  expect((await recover('idle', undefined, false))._tag).toBe('HistoryUnavailable');
  expect(await notices()).toEqual([]);
  expect(frames).toEqual([]);
});

test('fresh launch delivers ordinary new assignment context without a recovery notice', async () => {
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`DELETE FROM prime`);
    yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ? WHERE id =
      (SELECT context_message FROM assignment WHERE id = ?)`, [slot.slotId, assignmentId]);
    yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'fresh' });
  })));
  await recover();
  expect(await notices()).toEqual([]);
  expect(frames.map((frame) => frame.type)).toEqual(['prime', 'message']);
  expect(frames[0]).toMatchObject({ type: 'prime', text: expect.stringContaining('Situation: fresh') });
  expect(frames[1]).toMatchObject({ type: 'message', body: expect.stringContaining(`Assignment: ${assignmentId}`) });
});

test('allocation during the idle comparison cannot substitute a new assignment for interrupted work', async () => {
  let newAssignmentId: string | undefined;
  await recover('idle', async () => {
    await Effect.runPromise(store.change((change) => taskTransitionHandler({ factories: [{ factoryId: 'shop', config }] })(change, {
      ...slot, callId: 'finish-before-snapshot', tool: 'task_transition', args: {
        assignmentId, outcome: 'done', reason: 'completed while reconnecting', evidence: [],
      },
    })));
    const [assignment] = await Effect.runPromise(createAssignmentScheduler({ store, slots, factories: [{ factoryId: 'shop', config }] }).schedule());

    if (assignment === undefined) {throw new Error('missing new stage assignment');}

    newAssignmentId = assignment.id;
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ? WHERE id = ?`, [slot.slotId, assignment.contextMessage]);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'routed-context' });
    })));
  });
  expect(newAssignmentId).not.toBe(assignmentId);
  expect(await notices()).toEqual([]);
  expect(frames.filter((frame) => frame.type === 'message')).toEqual([
    expect.objectContaining({ type: 'message', body: expect.stringContaining(`Assignment: ${newAssignmentId}`) }),
  ]);
});

test('channel closure during idle comparison cannot create a notice', async () => {
  const reconciler = createReconciler(store);
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  await expect(reconciler.resumeAssignment(slot, { closed, send: async () => { close(); } }, assignmentId)).rejects.toThrow('channel ended');
  expect(await notices()).toEqual([]);
});
