// Integration tier: real disposable SQLite proves capacity constraints and atomic durable context.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema } from "effect";
import {
  acceptMessage, agentDelegateHandler, agentMessageHandler, agentReplyHandler, agentRequestHandler, assignedSlot, assignmentContextSlot, assignmentTicket, bindStationMessages, createAssignmentScheduler, createTicketService,
  foundryMigrations, messageBudget, openStore, planSlots, StoreError, storeApprovalsReader, taskTransitionHandler, ticketFactoryFrom, watchAssignments, composeResumeNotice,
} from "@foundry/daemon";
import type { Change, MessageAcceptance, Migration, Store } from "@foundry/daemon";
import { FactoryConfig } from "../src/config/schema.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", recovery_limit: 4,
  rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }, { id: "review", station: "floor.worker" }] } },
});

const slots = planSlots("shop", [{
  address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 2, isolation: "none",
}]);

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const fixture = async <A, E>(use: (store: Store, root: string) => Effect.Effect<A, E>, migrations: ReadonlyArray<Migration> = foundryMigrations) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-assignments-"));
  roots.push(root);

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db"), migrations });
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of slots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', ?, 'worker', ?, 'normal')`, [slot.slotId, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });

    for (let n = 1; n <= 3; n++) {
      yield* tickets.submit({ title: `Ticket ${n}`, spec: `Spec ${n}` }).pipe(Effect.orDie);
    }

    return yield* use(store, root);
  })));
};

const options = (store: Store) => ({ store, slots, factories: [{ factoryId: "shop", config }], configLoad: () => "load-1" });

const suspendWithOpenWork = (store: Store, assignmentId: string) => store.change((change) => Effect.gen(function* () {
  const notice = yield* acceptMessage(change, { factoryId: 'shop', senderSlot: 'worker/1', recipient: 'floor.worker',
    body: 'open work', delivery: 'after_turn', kind: 'ordinary', correlation: { ticket: 1 } }).pipe(Effect.orDie);

  yield* change.query(`UPDATE assignment SET status = 'suspended', recovery_count = 2 WHERE id = ?`, [assignmentId]);
  yield* change.query(`UPDATE ticket SET status = 'paused' WHERE number = 1`);
  yield* change.query(`INSERT INTO agent_request (id, factory_id, requester_slot, recipient, recipient_slot, ticket_number, notice_id, status, accepted_at, deadline)
    VALUES ('request-open', 'shop', 'worker/1', 'floor.worker', 'worker/2', 1, ?, 'open', 1, 9999999999999)`, [notice.id]);

  const delegationNotice = yield* acceptMessage(change, { factoryId: 'shop', senderSlot: 'worker/1', recipient: 'floor.worker',
    body: 'delegated work', delivery: 'after_turn', kind: 'delegation_notice', correlation: { ticket: 1 } }).pipe(Effect.orDie);

  yield* change.query(`INSERT INTO delegation (id, factory_id, root_assignment, delegating_slot, recipient, recipient_slot, depth, notice_id, status, accepted_at)
    VALUES ('delegation-open', 'shop', ?, 'worker/1', 'floor.worker', 'worker/2', 1, ?, 'open', 1)`, [assignmentId, delegationNotice.id]);

  const [transition] = yield* change.query<{ sequence: number }>(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
    from_state, from_stage, from_status, to_state, to_stage, to_status, outcome)
    VALUES ('shop', 1, 9999999999998, 'worker/1', 'stage', 'plan', 'assigned', 'stage', 'plan', 'paused', 'blocked') RETURNING sequence`);

  if (transition === undefined) {throw new Error('missing fixture transition');}

  yield* change.query(`INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
    VALUES ('shop', 1, ?, ?, 'blocked', 'open', 1)`, [assignmentId, transition.sequence]);
  yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'suspended' });
}));

test("resume queues for a busy original slot, then preserves assignment, work and one refreshed notice", async () => {
  await fixture((store, root) => Effect.gen(function* () {
    const scheduler = createAssignmentScheduler(options(store));
    const initial = yield* scheduler.schedule();
    const original = initial.find((row) => row.ticket === 1);

    if (original === undefined) {throw new Error('no assignment');}

    yield* suspendWithOpenWork(store, original.id);
    // Another ticket takes the freed slot. Resume must wait, not steal it or use a new slot.
    yield* scheduler.schedule();
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
    expect((yield* tickets.resume('shop', 1, 'Continue carefully')).ticket.status).toBe('queued');
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* store.read(`SELECT state FROM approval`)).toEqual([{ state: 'resolved' }]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1 WHERE ticket_number = 3`);
      yield* change.query(`UPDATE ticket SET status = 'paused' WHERE number = 3`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'free' });
    }));
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toMatchObject([{ id: original.id, ticket: 1, slotId: original.slotId }]);
    expect(yield* store.read(`SELECT status, recovery_count, recovery_ceiling FROM assignment WHERE id = ?`, [original.id]))
      .toEqual([{ status: 'active', recovery_count: 2, recovery_ceiling: 4 }]);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: 'open' }]);
    expect(yield* store.read(`SELECT status FROM agent_request`)).toEqual([{ status: 'open' }]);
    const [notice] = yield* store.read<{ id: string; body: string }>(`SELECT * FROM message WHERE kind = 'resume_notice'`);
    expect(notice).toMatchObject({ sender_kind: 'daemon', delivery: 'after_turn', bound_slot: original.slotId });
    expect(notice?.body).toContain('Continue carefully');
    expect(notice?.body).toContain('request-open');
    expect(notice?.body).toContain('delegation-open');
    expect(notice?.body).toContain('Reported outcome: blocked');
    expect(notice?.body).toContain('Inspect the worktree and ticket directory');
    yield* store.change((change) => composeResumeNotice(change, { assignmentId: original.id, factoryId: 'shop', ticket: 1,
      stage: 'plan', slotId: original.slotId, recipient: 'floor.worker', message: 'Second interruption' }));
    expect(yield* store.read(`SELECT id FROM message WHERE kind = 'resume_notice'`)).toEqual([{ id: notice?.id }]);
    expect((yield* store.read<{ body: string }>(`SELECT body FROM message WHERE id = ?`, [notice?.id ?? '']))[0]?.body).toContain('Second interruption');
    expect(yield* store.read(`SELECT messages_spent FROM ticket WHERE number = 1`)).toEqual([{ messages_spent: 0 }]);
    expect(Exit.isFailure(yield* Effect.exit(tickets.resume('shop', 1)))).toBe(true);
  }));
});

test("parked-slot resume waits for fallback capacity then abandons and notifies open work", async () => {
  await fixture((store, root) => Effect.gen(function* () {
    const scheduler = createAssignmentScheduler(options(store));
    const [original] = yield* scheduler.schedule();

    if (original === undefined) {throw new Error('no assignment');}

    yield* suspendWithOpenWork(store, original.id);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'parked' WHERE slot_id = 'worker/1'`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'parked' });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
    yield* tickets.resume('shop', 1, 'Use the preserved worktree', true);
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: 'open' }]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1 WHERE ticket_number = 2`);
      yield* change.query(`UPDATE ticket SET status = 'paused' WHERE number = 2`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'free' });
    }));
    const replacement = yield* createAssignmentScheduler(options(store)).schedule();
    expect(replacement).toMatchObject([{ ticket: 1, slotId: 'worker/2' }]);
    expect(replacement[0]?.id).not.toBe(original.id);
    expect(yield* store.read(`SELECT status, end_reason FROM assignment WHERE id = ?`, [original.id])).toEqual([{ status: 'ended', end_reason: 'abandoned' }]);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: 'abandoned' }]);
    expect(yield* store.read(`SELECT status FROM agent_request`)).toEqual([{ status: 'failed' }]);
    const notifications = yield* store.read(`SELECT bound_slot FROM message WHERE body LIKE '%was abandoned on resume%' ORDER BY bound_slot`);
    expect(notifications).toEqual([{ bound_slot: 'worker/1' }, { bound_slot: 'worker/2' }]);
    expect(yield* store.read(`SELECT body FROM message WHERE kind = 'resume_notice'`)).toEqual([{ body: expect.stringContaining('Use the preserved worktree') }]);
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* store.read(`SELECT condition FROM slot WHERE slot_id = 'worker/1'`)).toEqual([{ condition: 'parked' }]);
  }));
});

test('resume cannot bypass a message-limit decision before the allowance-grant workflow is implemented', async () => {
  await fixture((store, root) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET message_ceiling = 1 WHERE number = 1`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'one-message' });
    }));
    yield* store.change((change) => agentMessageHandler(slots, { assignmentTicket, budget: messageBudget() })(change, {
      factoryId: 'shop', slotId: 'worker/1', launchId: 'fixture', callId: 'last-message', tool: 'agent_message',
      args: { recipient: 'floor.worker', body: 'last allowed message' },
    }));
    const before = yield* snapshot(store);
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
    expect(Exit.isFailure(yield* Effect.exit(tickets.resume('shop', 1)))).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* store.read(`SELECT state FROM approval WHERE kind = 'limit_reached'`)).toEqual([{ state: 'open' }]);
  }));
});

const snapshot = (store: Store) => Effect.all({
  tickets: store.read(`SELECT number, state, stage, status, messages_spent FROM ticket ORDER BY number`),
  assignments: store.read(`SELECT * FROM assignment ORDER BY created_at, ticket_number`),
  messages: store.read<{ body: string }>(`SELECT * FROM message ORDER BY sequence`),
  transitions: store.read(`SELECT * FROM ticket_transition ORDER BY sequence`),
  history: store.read(`SELECT * FROM history ORDER BY sequence`),
});

test("oldest first, one context per assignment across repeated and concurrent scans and restart", async () => {
  const saved = await fixture((store, root) => Effect.gen(function* () {
    // Submission timestamps, not ticket number, are authoritative. Put ticket 3 first.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET submitted_at = number * 100 WHERE number != 3`);
      yield* change.query(`UPDATE ticket SET submitted_at = 0 WHERE number = 3`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "ordering" });
    }));
    const scheduler = createAssignmentScheduler(options(store));
    const scans = yield* Effect.all([scheduler.schedule(), scheduler.schedule()], { concurrency: "unbounded" });
    const assigned = scans.flat();
    expect(assigned.map((a) => [a.ticket, a.slotId])).toEqual([[3, "worker/1"], [1, "worker/2"]]);
    const before = yield* snapshot(store);
    expect(before.messages).toHaveLength(2);
    expect(before.transitions).toHaveLength(5); // submit plus exactly one assignment transition
    expect(before.messages).toMatchObject([
      { ticket_number: 3, recipient: "floor.worker", sender_kind: "daemon", sender_slot: null, status: "unbound", delivery: "after_turn" },
      { ticket_number: 1 },
    ]);
    expect(before.messages[0]?.body).toContain("Specification:");
    expect(before.assignments).toMatchObject([
      { recovery_count: 0, recovery_ceiling: 4 }, { recovery_count: 0, recovery_ceiling: 4 },
    ]);
    expect(before.transitions[3]).toMatchObject({ actor: "daemon", from_state: "backlog", to_stage: "plan", to_status: "assigned", config_load: "load-1" });
    expect(yield* assignedSlot(store.read, "shop", 3)).toBe("worker/1");
    expect(yield* assignedSlot(store.read, "other", 3)).toBeNull();
    yield* Effect.all([scheduler.schedule(), scheduler.schedule()], { concurrency: "unbounded" });
    expect(yield* snapshot(store)).toEqual(before);
    // A new scheduler has no in-memory dedup state.
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(before);

    return { root, before };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(saved.before);
  })));
});

test("queued stages, frozen/parked slots and lifecycle/readiness gates are respected", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = CASE ordinal WHEN 1 THEN 'frozen' ELSE 'parked' END`);
      yield* change.query(`UPDATE ticket SET state = 'stage', stage = 'review', status = 'queued' WHERE number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "conditions" });
    }));
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'normal' WHERE ordinal = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "unpark" });
    }));
    expect(yield* createAssignmentScheduler({ ...options(store), inScope: () => false }).schedule()).toEqual([]);
    expect(yield* createAssignmentScheduler({ ...options(store), ready: () => false }).schedule()).toEqual([]);
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toMatchObject([{ ticket: 1, stage: "review", slotId: "worker/2" }]);
    yield* store.change((change) => Effect.gen(function* () {
      expect(yield* assignmentTicket(change, "shop", "worker/2")).toBe(1);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "lookup" });
    }));
  }));
});

test("returning work waits for its last slot at that stage across scheduler restart", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1, created_at = 0 WHERE ticket_number = 1`);
      // Equal timestamps still choose the last inserted assignment; another stage must not win.
      yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, ended_at, context_message)
        SELECT 'return-plan', factory_id, ticket_number, 'plan', 'worker/2', 'ended', 4, 0, 1, context_message
        FROM assignment WHERE ticket_number = 1`);
      yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, ended_at, context_message)
        SELECT 'later-review', factory_id, ticket_number, 'review', 'worker/1', 'ended', 4, 2, 3, context_message
        FROM assignment WHERE id = 'return-plan'`);
      yield* change.query(`UPDATE ticket SET status = 'queued' WHERE number = 1`);
      yield* change.query(`UPDATE ticket SET state = 'stage', stage = 'plan', status = 'paused' WHERE number = 3`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "return" });
    }));
    const before = yield* snapshot(store);
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(before);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 4 WHERE ticket_number = 2`);
      yield* change.query(`UPDATE ticket SET status = 'paused' WHERE number = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "free-prior" });
    }));
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toMatchObject([
      { ticket: 1, stage: "plan", slotId: "worker/2" },
    ]);
  }));
});

test("routing uses current assignment preference but pins each context to its original slot", async () => {
  await fixture((store) => Effect.gen(function* () {
    const assigned = yield* createAssignmentScheduler(options(store)).schedule();
    const first = assigned[0];
    const second = assigned[1];
    expect(first?.slotId).toBe("worker/1");
    expect(second?.slotId).toBe("worker/2");

    const routing = { store, slots,
      assignedSlot: (change: Change, factoryId: string, ticket: number) => assignedSlot(change.query, factoryId, ticket),
      contextSlot: assignmentContextSlot,
    };

    // A context cannot fall back to another normal slot when its assigned slot freezes.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'frozen' WHERE ordinal = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "freeze" });
    }));
    expect(yield* bindStationMessages(routing)).toMatchObject([{ id: first?.contextMessage, slotId: "worker/1" }]);
    expect(yield* store.read(`SELECT status, bound_slot FROM message WHERE ticket_number = 2`)).toEqual([{ status: "unbound", bound_slot: null }]);
    yield* store.change((change) => Effect.gen(function* () {
      // End the original assignments before binding the second context: it must still go to slot 2.
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE slot SET condition = CASE ordinal WHEN 1 THEN 'frozen' ELSE 'normal' END`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "release" });
    }));
    expect(yield* bindStationMessages(routing)).toMatchObject([{ id: second?.contextMessage, slotId: "worker/2" }]);
    // Ticket 3 takes slot 2. Restore slot 1 before routing: current assignment beats lowest ordinal.
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toMatchObject([{ ticket: 3, slotId: "worker/2" }]);

    const ordinary = yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'normal' WHERE ordinal = 1`);

      return yield* acceptMessage(change, {
        factoryId: "shop", senderSlot: "worker/1", recipient: "floor.worker", body: "ticket question",
        kind: "ordinary", delivery: "after_turn", correlation: { ticket: 3 },
      });
    }));

    expect(yield* bindStationMessages(routing)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ordinary.id, slotId: "worker/2" }),
    ]));
    expect(yield* bindStationMessages(routing)).toEqual([]);
    expect(yield* store.read(`SELECT ticket_number, bound_slot FROM message ORDER BY sequence`)).toEqual([
      { ticket_number: 1, bound_slot: "worker/1" }, { ticket_number: 2, bound_slot: "worker/2" },
      { ticket_number: 3, bound_slot: "worker/2" }, { ticket_number: 3, bound_slot: "worker/2" },
    ]);
  }));
});

test("non-isolated assignments use factory context and repository messages stay pinned after the assignment ends", async () => {
  await fixture((store, root) => Effect.gen(function* () {
    const clone = join(root, "clone");
    const branch = join(root, "branch");
    mkdirSync(clone);
    mkdirSync(branch);
    writeFileSync(join(clone, "AGENTS.md"), "Factory default context");
    writeFileSync(join(branch, "AGENTS.md"), "Wrong branch context");
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?`, [branch]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "worktree" });
    }));
    yield* createAssignmentScheduler({ ...options(store), clonePath: () => clone }).schedule();

    const contexts = yield* store.read<{ message_id: string; slot_id: string; body: string }>(
      `SELECT r.message_id, r.slot_id, m.body FROM repository_context r JOIN message m ON m.id = r.message_id ORDER BY m.sequence`,
    );

    expect(contexts).toHaveLength(2);

    for (const context of contexts) {
      expect(context.body).toContain("Factory default context");
      expect(context.body).not.toContain("Wrong branch context");
    }

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE slot SET condition = 'frozen' WHERE ordinal = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "end and freeze" });
    }));
    const bindings = yield* bindStationMessages({ store, slots, contextSlot: assignmentContextSlot });
    expect(bindings).toEqual(expect.arrayContaining([expect.objectContaining({ id: contexts[0]?.message_id, slotId: "worker/1" })]));
    expect(bindings).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: contexts[1]?.message_id })]));
  }));
});

test("ordinary messages and request notices inherit the real active assignment, not caller ticket fields", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();

    const call = {
      factoryId: "shop", slotId: "worker/2", launchId: "launch", callId: "call", tool: "agent_message",
      args: { recipient: "floor.worker", body: "question", timeoutMs: 1000, ticket: 999 },
    };

    yield* store.change((change) => agentMessageHandler(slots, { assignmentTicket })(change, call));
    yield* store.change((change) => agentRequestHandler(slots, { assignmentTicket })(change, { ...call, tool: "agent_request" }));
    expect(yield* store.read(`SELECT ticket_number, kind FROM message WHERE sender_slot = 'worker/2' ORDER BY sequence`)).toEqual([
      { ticket_number: 2, kind: "ordinary" }, { ticket_number: 2, kind: "request_notice" },
    ]);
    expect(yield* store.read(`SELECT ticket_number, requester_slot FROM agent_request`)).toEqual([
      { ticket_number: 2, requester_slot: "worker/2" },
    ]);
  }));
});

test("failure after all assignment effects rolls back ticket, transition, assignment, context and history", async () => {
  await fixture((store, root) => Effect.gen(function* () {
    writeFileSync(join(root, "AGENTS.md"), "Atomic context");
    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    const exit = yield* Effect.exit(createAssignmentScheduler({ ...options(failing), clonePath: () => root }).schedule());
    expect(exit).toMatchObject(Exit.fail({ reason: "Sql" }));
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* store.read(`SELECT * FROM repository_context`)).toEqual([]);
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toHaveLength(2);
  }));
});

test("commit wakeups assign startup backlog and newly freed capacity; stopping removes the watcher", async () => {
  await fixture((store) => Effect.gen(function* () {
    // Synchronize on actual commits, not sleeps or polling.
    let nextCommit: (() => void) | undefined;
    const unsubscribe = store.onCommit(() => nextCommit?.());
    const committed = () => new Promise<void>((resolve) => { nextCommit = resolve; });
    const errors: Array<Error> = [];
    const first = committed();
    const stop = watchAssignments(options(store), (error) => errors.push(error));
    yield* Effect.promise(() => first);
    expect(yield* store.read(`SELECT ticket_number FROM assignment ORDER BY ticket_number`)).toEqual([
      { ticket_number: 1 }, { ticket_number: 2 },
    ]);
    // Release capacity, as a separate outcome transaction would. Ticket 3 must be picked up.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1 WHERE ticket_number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "freed" });
    }));
    const next = committed();
    yield* Effect.promise(() => next);
    yield* Effect.promise(stop);
    unsubscribe();
    expect(errors).toEqual([]);
    expect(yield* assignedSlot(store.read, "shop", 3)).toBe("worker/1");
    const before = yield* snapshot(store);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 2 WHERE ticket_number = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "after-stop" });
    }));
    expect((yield* snapshot(store)).messages).toEqual(before.messages);
  }));
});

test("database rejects a second unended assignment per ticket and a second active assignment per slot", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    const before = yield* snapshot(store);

    for (const [ticket, status] of [[1, "suspended"], [3, "active"]] as const) {
      const exit = yield* Effect.exit(store.change((change) => Effect.gen(function* () {
        yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
          SELECT 'duplicate', 'shop', ?, 'plan', 'worker/1', ?, 4, 0, id FROM message LIMIT 1`, [ticket, status]);
        yield* change.recordHistory({ factoryId: "shop", kind: "probe", subject: "duplicate" });
      })));

      expect(exit).toMatchObject(Exit.fail({ reason: "Sql" }));
    }

    expect(yield* snapshot(store)).toEqual(before);
  }));
});

// Store integration: exercise shared acceptance rather than duplicate each tool's validation.
test("message threshold commits with suspension and readable approval; exempt sends spend nothing", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET message_ceiling = 4 WHERE number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "allowance" });
    }));
    const guards = { assignmentTicket, budget: messageBudget(() => "load-1") };

    const send = (kind: "ordinary" | "request_notice" | "reply" | "delegation_notice") => {
      const input: MessageAcceptance = {
        factoryId: "shop", senderSlot: "worker/1", recipient: "floor.worker", body: kind,
        kind, delivery: "after_turn",
      };

      const attributed = kind === "ordinary" ? input : { ...input, correlation: { ticket: 1 } };

      return store.change((change) => acceptMessage(change, attributed, guards));
    };

    for (const senderKind of ["daemon", "operator"] as const) {
      yield* store.change((change) => acceptMessage(change, {
        factoryId: "shop", senderKind, senderSlot: null, recipient: "floor.worker", body: "context",
        kind: "ordinary", delivery: "after_turn", correlation: { ticket: 1 },
      }, guards));
    }

    yield* store.change((change) => acceptMessage(change, {
      factoryId: "shop", senderSlot: "unassigned/1", recipient: "floor.worker", body: "no ticket",
      kind: "ordinary", delivery: "after_turn",
    }, guards));
    expect(yield* store.read(`SELECT messages_spent FROM ticket WHERE number = 1`)).toEqual([{ messages_spent: 0 }]);
    yield* send("ordinary");
    yield* send("request_notice");
    yield* send("reply");
    expect(yield* store.read(`SELECT status, messages_spent FROM ticket WHERE number = 1`)).toEqual([{ status: "assigned", messages_spent: 3 }]);
    const before = yield* snapshot(store);

    const failed = yield* Effect.exit(store.change((change) => Effect.gen(function* () {
      yield* acceptMessage(change, { factoryId: "shop", senderSlot: "worker/1", recipient: "floor.worker",
        body: "rolled back", kind: "delegation_notice", delivery: "after_turn" }, guards);
      yield* change.query(`INSERT INTO nonexistent_table VALUES (1)`);
    })));

    expect(Exit.isFailure(failed)).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* store.read(`SELECT * FROM approval`)).toEqual([]);
    const threshold = yield* send("delegation_notice");
    expect(yield* store.read(`SELECT id FROM message WHERE id = ?`, [threshold.id])).toEqual([{ id: threshold.id }]);
    expect(yield* store.read(`SELECT status, messages_spent, message_ceiling FROM ticket WHERE number = 1`))
      .toEqual([{ status: "paused", messages_spent: 4, message_ceiling: 4 }]);
    expect(yield* assignedSlot(store.read, "shop", 1)).toBeNull();
    expect(yield* store.read(`SELECT status FROM assignment WHERE ticket_number = 1`)).toEqual([{ status: "suspended" }]);
    const approvals = yield* Effect.promise(() => storeApprovalsReader(store).list());
    expect(approvals.approvals).toMatchObject([{ kind: "limit_reached", ticket: 1, outcome: null, configLoad: "load-1" }]);
    const after = yield* snapshot(store);
    expect(Exit.isFailure(yield* Effect.exit(send("reply")))).toBe(true);
    expect(yield* snapshot(store)).toEqual(after);
    expect(after.transitions).toHaveLength(before.transitions.length + 1);

    const call = { factoryId: "shop", slotId: "worker/1", launchId: "fixture", callId: "post-limit", tool: "agent_message",
      args: { recipient: "floor.worker", body: "must not become ticketless" } };

    for (const handler of [agentMessageHandler(slots, guards), agentRequestHandler(slots, guards)]) {
      const exit = yield* Effect.exit(store.change((change) => handler(change, { ...call, args: { ...call.args, timeoutMs: 60_000 } })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* snapshot(store)).toEqual(after);
    }

    expect(yield* store.read(`SELECT id FROM agent_request`)).toEqual([]);
    // Freed capacity may take another ticket; its active assignment wins attribution.
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toMatchObject([{ ticket: 3, slotId: "worker/1" }]);
    yield* store.change((change) => agentMessageHandler(slots, guards)(change, call));
    expect(yield* store.read(`SELECT messages_spent FROM ticket WHERE number = 3`)).toEqual([{ messages_spent: 1 }]);
    expect(yield* store.read(`SELECT ticket_number FROM message WHERE body = ?`, [call.args.body])).toEqual([{ ticket_number: 3 }]);
  }));
});

test("message limit migration preserves existing blocked and worker-request decisions", async () => {
  const saved = await fixture((store, root) => Effect.gen(function* () {
    // Historical fixtures must not invoke today's scheduler, which now needs resume tables.
    const assignment = { id: 'historical-assignment', ticket: 1, slotId: 'worker/1' };
    yield* store.change((change) => Effect.gen(function* () {
      const context = yield* acceptMessage(change, { factoryId: 'shop', senderKind: 'daemon', senderSlot: null,
        recipient: 'floor.worker', body: 'historical context', kind: 'ordinary', delivery: 'after_turn', correlation: { ticket: 1 } });

      yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
        VALUES (?, 'shop', 1, 'plan', 'worker/1', 'active', 4, 1, ?)`, [assignment.id, context.id]);
      yield* change.query(`UPDATE ticket SET state = 'stage', stage = 'plan', status = 'assigned' WHERE number = 1`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: assignment.id });
    }));

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO approval (factory_id, ticket_number, assignment_id, kind, state, raised_at, request_body, request_stage)
        VALUES ('shop', ?, ?, 'worker_request', 'open', 1, 'operator question', 'plan')`, [assignment.ticket, assignment.id]);
      yield* taskTransitionHandler(options(store))(change, { factoryId: "shop", slotId: assignment.slotId, launchId: "fixture", callId: "blocked", tool: "task_transition",
        args: { assignmentId: assignment.id, outcome: "blocked", reason: "needs decision", evidence: [] } });
    }));

    return { root, approvals: yield* store.read(`SELECT * FROM approval ORDER BY id`) };
  }), foundryMigrations.filter((migration) => migration.id < 24));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* store.read(`SELECT * FROM approval ORDER BY id`)).toEqual(saved.approvals.map((approval) => ({ ...approval, decision: null, resolution_transition: null })));
    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);
    expect((yield* Effect.promise(() => storeApprovalsReader(store).list())).approvals.map((approval) => approval.kind))
      .toEqual(["worker_request", "blocked"]);
  })));
});

test("a selected delegation reply reaches the ceiling while the root is suspended", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    const guards = { assignmentTicket, budget: messageBudget(() => "load-1") };

    const call = { factoryId: "shop", slotId: "worker/1", launchId: "fixture", callId: "delegate", tool: "agent_delegate",
      args: { recipient: "floor.worker", body: "help" } };

    yield* store.change((change) => agentDelegateHandler(slots, guards)(change, call));
    const [delegation] = yield* store.read<{ id: string }>(`SELECT id FROM delegation`);

    if (delegation === undefined) {throw new Error("delegation missing");}

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET recipient_slot = 'worker/2'`);
      yield* change.query(`UPDATE assignment SET status = 'suspended' WHERE ticket_number = 1`);
      yield* change.query(`UPDATE ticket SET status = 'paused', message_ceiling = 2 WHERE number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "suspended root" });
    }));
    yield* store.change((change) => agentReplyHandler(guards)(change, { ...call, slotId: "worker/2", tool: "agent_reply",
      args: { delegationId: delegation.id, outcome: "done", evidence: "evidence/result.md" } }));
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "completed" }]);
    expect(yield* store.read(`SELECT messages_spent, status FROM ticket WHERE number = 1`)).toEqual([{ messages_spent: 2, status: "paused" }]);
    expect((yield* Effect.promise(() => storeApprovalsReader(store).list())).approvals).toMatchObject([{ kind: "limit_reached", ticket: 1 }]);
    expect(yield* store.read(`SELECT kind, status, bound_slot FROM message WHERE delegation_id = ? ORDER BY sequence`, [delegation.id]))
      .toMatchObject([{ kind: "delegation_notice" }, { kind: "reply", status: "bound", bound_slot: "worker/1" }]);
  }));
});

test.each(["suspended", "ended"] as const)("correlated replies spend allowance after assignment is %s", async (status) => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    const guards = { assignmentTicket, budget: messageBudget(() => "load-1") };

    const call = { factoryId: "shop", slotId: "worker/1", launchId: "fixture", callId: "request", tool: "agent_request",
      args: { recipient: "floor.worker", body: "question", timeoutMs: 60_000 } };

    yield* store.change((change) => agentRequestHandler(slots, guards)(change, call));
    const requests = yield* store.read<{ id: string }>(`SELECT id FROM agent_request`);
    const requestId = requests[0]?.id;

    if (requestId === undefined) {throw new Error("request missing");}

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE agent_request SET recipient_slot = 'worker/2' WHERE id = ?`, [requestId]);
      yield* change.query(`UPDATE assignment SET status = ?, ended_at = ? WHERE ticket_number = 1`, [status, status === "ended" ? 1 : null]);
      yield* change.query(`UPDATE ticket SET status = ?, message_ceiling = 3 WHERE number = 1`, [status === "ended" ? "queued" : "paused"]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: status });
    }));
    const reply = { ...call, slotId: "worker/2", tool: "agent_reply", args: { requestId, body: "answer" } };
    yield* store.change((change) => agentReplyHandler(guards)(change, reply));
    expect(yield* store.read(`SELECT status FROM agent_request WHERE id = ?`, [requestId])).toEqual([{ status: "completed" }]);
    expect(yield* store.read(`SELECT messages_spent FROM ticket WHERE number = 1`)).toEqual([{ messages_spent: 2 }]);
    // A further correlated message reaches the limit even without an active assignment.
    yield* store.change((change) => acceptMessage(change, { factoryId: "shop", senderSlot: "worker/2", recipient: "worker/1",
      body: "threshold", kind: "reply", delivery: "after_turn", correlation: { ticket: 1 } }, guards));
    expect(yield* store.read(`SELECT messages_spent, status FROM ticket WHERE number = 1`)).toEqual([{ messages_spent: 3, status: "paused" }]);
    expect((yield* Effect.promise(() => storeApprovalsReader(store).list())).approvals).toMatchObject([{ kind: "limit_reached", ticket: 1 }]);
    expect(yield* store.read(`SELECT status FROM assignment WHERE ticket_number = 1`)).toEqual([{ status }]);
  }));
});
