// Integration tier: disposable SQLite proves atomic abandonment and the scheduler's fresh context.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import {
  agentDelegateHandler, agentRequestHandler, assignmentTicket, createAssignmentScheduler,
  createMessageDelivery, createMessageDisposition, createReconciler, detectStuckWorkers, openSlotGate,
  createTicketService, openStore, planSlots, serveManagementApi, SlotsError, StoreError, taskTransitionHandler, ticketFactoryFrom,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { runTicketRetry } from "@foundry/cli";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame, Hello } from "@foundry/protocol";
import { FactoryConfig } from "../src/config/schema.js";
import { resendAssignmentRepositoryContext } from "../src/assignment-repository-context.js";
import { composeResumeNotice } from "../src/resume-notice.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", recovery_limit: 4,
  rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }] } },
});

const slots = planSlots("shop", [{ address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 3, isolation: "none" }]);

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const owner = { factoryId: "shop", slotId: "worker/1", launchId: "launch-1", callId: "fixture", tool: "fixture" };

const snapshot = (store: Store) => Effect.all(Object.fromEntries(
  ["ticket", "assignment", "ticket_transition", "agent_request", "delegation", "approval", "message", "history"]
    .map((table) => [table, store.read(`SELECT * FROM ${table} ORDER BY rowid`)]),
));

const fixture = <A, E>(use: (store: Store, id: string, root: string) => Effect.Effect<A, E>) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-retry-"));
  roots.push(root);

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db") });
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of slots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition)
          VALUES ('shop', ?, 'worker', ?, 'normal')`, [slot.slotId, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
    }));
    yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] })
      .submit({ title: "Retry plan", spec: "Original specification" });
    const [assignment] = yield* scheduler(store).schedule();

    if (assignment === undefined) {throw new Error("fixture did not assign");}

    return yield* use(store, assignment.id, root);
  })));
};

const scheduler = (store: Store) => createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config }] });

const service = (store: Store, root: string) => createTicketService({ store, stateRoot: root,
  factories: () => [ticketFactoryFrom(config)], configLoad: () => "retry-load" });

const block = (store: Store, id: string) => store.change((change) => taskTransitionHandler({ factories: [{ factoryId: "shop", config }] })(change,
  { ...owner, args: { assignmentId: id, outcome: "blocked", reason: "Need help", evidence: [] } }));

const obligations = (store: Store) => store.change((change) => Effect.gen(function* () {
  yield* agentRequestHandler(slots, { assignmentTicket })(change, { ...owner,
    args: { recipient: "floor.worker", body: "Question", timeoutMs: 600_000 } });

  yield* agentDelegateHandler(slots)(change, { ...owner,
    args: { recipient: "floor.worker", body: "Delegate" } });

  // Routing is a separate boundary. Seed a selected parent to exercise descendant closure.
  yield* change.query(`UPDATE delegation SET recipient_slot = 'worker/2'`);
  const [parent] = yield* change.query<{ id: string }>(`SELECT id FROM delegation WHERE parent_id IS NULL`);

  if (parent === undefined) {throw new Error("fixture did not delegate");}

  yield* agentDelegateHandler(slots)(change, { ...owner, slotId: "worker/2",
    args: { recipient: "floor.worker", body: "Child", parentDelegationId: parent.id } });
  yield* change.query(`UPDATE delegation SET recipient_slot = 'worker/3' WHERE parent_id IS NOT NULL`);
  yield* change.query(`UPDATE agent_request SET recipient_slot = 'worker/2'`);
  yield* change.query(`UPDATE assignment SET recovery_count = 3`);
}));

test("retry closes the whole obligation tree and blocked approval; restart queues fresh context without touching artifacts", async () => {
  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    yield* obligations(store);
    yield* block(store, id);
    const before = yield* service(store, root).show("shop", 1);
    const evidence = join(before.ticket.evidencePath, "proof.md");
    const worktree = join(root, "disposable-worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "dirty.txt"), "Uncommitted artifact");
    writeFileSync(evidence, "Keep evidence");
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'ticket-branch', start_commit = 'original-head'`, [worktree]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "artifacts" });
    }));
    const detail = yield* service(store, root).retry("shop", 1);
    expect(detail.ticket).toMatchObject({ status: "queued", stage: "plan", messages: before.ticket.messages,
      rejections: before.ticket.rejections, worktree: { path: worktree, branch: "ticket-branch", startCommit: "original-head" } });
    expect(detail.transitions).toHaveLength(before.transitions.length + 1);
    expect(detail.transitions.at(-1)).toMatchObject({ actor: "operator", from: { status: "paused" },
      to: { status: "queued" }, reason: "ticket retry", configLoad: "retry-load" });
    expect(yield* store.read(`SELECT status, end_reason, recovery_count FROM assignment`))
      .toEqual([{ status: "ended", end_reason: "abandoned", recovery_count: 3 }]);
    expect(yield* store.read(`SELECT status FROM agent_request`)).toEqual([{ status: "abandoned" }]);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "abandoned" }, { status: "abandoned" }]);
    expect(yield* store.read(`SELECT state, closed_at FROM approval`)).toEqual([{ state: "resolved", closed_at: expect.any(Number) }]);
    const notices = yield* store.read<{ bound_slot: string; body: string }>(`SELECT bound_slot, body FROM message WHERE sender_kind = 'daemon' AND body LIKE '%abandoned%'`);
    expect(notices.map((n) => n.bound_slot)).toEqual(["worker/2", "worker/2", "worker/2", "worker/3"]);
    expect(notices.every((n) => n.body.includes(id))).toBe(true);
    const after = yield* snapshot(store);
    expect(yield* service(store, root).retry("shop", 1).pipe(Effect.flip)).toMatchObject({ code: "invalid_state" });
    expect(yield* snapshot(store)).toEqual(after);
    expect(readFileSync(before.ticket.specPath, "utf8")).toBe("Original specification");
    expect(readFileSync(evidence, "utf8")).toBe("Keep evidence");
    expect(readFileSync(join(worktree, "dirty.txt"), "utf8")).toBe("Uncommitted artifact");

    return { root, id, after };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    const [fresh] = yield* scheduler(store).schedule();
    expect(fresh).toMatchObject({ ticket: 1, stage: "plan", slotId: "worker/1" });
    expect(fresh?.id).not.toBe(saved.id);
    expect(yield* store.read(`SELECT recovery_count, recovery_ceiling FROM assignment WHERE status = 'active'`))
      .toEqual([{ recovery_count: 0, recovery_ceiling: 4 }]);
    const [context] = yield* store.read<{ body: string }>(`SELECT body FROM message WHERE id = ?`, [fresh?.contextMessage ?? "missing"]);
    expect(context?.body).toContain("Ticket 1: Retry plan");
    expect(context?.body).toContain(`Specification: ${join(saved.root, "tickets/shop/1/spec.md")}`);
    expect(context?.body).toContain("Stage: plan");
    expect(context?.body).toContain("Evidence:");
    expect(context?.body).toContain(`Assignment: ${fresh?.id}`);
  })));
});

test("attempted old work and restored context cannot rearm after retry; fresh context still delivers", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    yield* obligations(store);
    const restore = () => resendAssignmentRepositoryContext(store, { factoryId: "shop", slotId: "worker/1", clonePath: root, isolation: "none" });
    yield* restore();
    yield* store.change((change) => composeResumeNotice(change, { assignmentId: id, factoryId: "shop", ticket: 1,
      stage: "plan", slotId: "worker/1", recipient: "floor.worker" }));
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET status = 'bound', bound_slot = CASE
        WHEN kind = 'delegation_notice' AND delegation_id IN (SELECT id FROM delegation WHERE parent_id IS NOT NULL)
          THEN 'worker/3' WHEN kind IN ('request_notice', 'delegation_notice') THEN 'worker/2' ELSE 'worker/1' END,
        bound_at = 1 WHERE status = 'unbound'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "selected" });
    }));
    const claimed = slots.map((slot) => ({ factoryId: "shop", slotId: slot.slotId, launchId: `launch-${slot.ordinal}` }));
    const errors: Array<unknown> = [];
    const pump = () => createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => errors.push(cause) });
    const old = pump();
    yield* Effect.promise(async () => {
      try {
        for (const slot of claimed) {old.attach(slot, { send: async () => {} });}

        await old.idle();
      } finally {await old.stop();}
    });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message_attempt SET injected_at = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "injected" });
    }));
    const attempts = yield* store.read<{ message_id: string }>(`SELECT * FROM message_attempt ORDER BY rowid`);
    expect(attempts).toHaveLength(6);
    yield* restore();
    const restored = yield* store.read<{ message_id: string }>(`SELECT message_id FROM repository_context ORDER BY rowid`);
    expect(restored).toHaveLength(2);
    yield* block(store, id);
    yield* service(store, root).retry("shop", 1);
    expect(yield* store.read(`SELECT status FROM message WHERE id = ?`, [restored[1]?.message_id ?? "missing"]))
      .toEqual([{ status: "dropped" }]);
    const reconciler = createReconciler(store);
    yield* Effect.promise(async () => {
      for (const slot of claimed) {
        const hello: Hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, ...slot,
          conversationRef: "fixture-conversation", hasRecoverableHistory: true, mode: "headless", tools: [] };

        for (const uncertain of ["pending", "absent"] as const) {
          await reconciler.reconcile(slot, hello, { send: async (frame) => {
            if (frame.type !== "reconcile") {throw new Error("expected reconciliation");}

            reconciler.receive(slot, { type: "reconciliation_answer", requestId: frame.requestId, lifecycle: "unknown",
              answers: frame.ids.map((messageId) => ({ id: messageId, status: uncertain })) });
          } });
        }

        expect(await Effect.runPromise(store.read(`SELECT retired_at FROM message_attempt WHERE slot_id = ?`, [slot.slotId])))
          .toEqual(expect.arrayContaining([{ retired_at: null }]));
      }
    });
    // PRD §6.3/§10.2 (FOU-84): absence on the same launch with an unknown lifecycle is ambiguous.
    // It is held for the operator, never retired or re-armed automatically.
    const oldIds = new Set(attempts.map((attempt) => attempt.message_id));
    const held = yield* store.read<{ id: string }>(`SELECT id FROM message WHERE status = 'indeterminate' ORDER BY id`);
    expect(new Set(held.map((row) => row.id))).toEqual(oldIds);
    expect(yield* store.read(`SELECT kind, subject FROM operator_hold WHERE closed_at IS NULL ORDER BY subject`))
      .toEqual(held.map((row) => ({ kind: "indeterminate_message", subject: row.id })));
    const unretired = yield* store.read<{ message_id: string }>(`SELECT * FROM message_attempt ORDER BY rowid`);
    expect(unretired).toEqual(attempts);
    // Even an explicit operator resend re-binds abandoned work but cannot deliver it.
    const disposition = createMessageDisposition(store);

    for (const row of held) {yield* disposition.act(row.id, "resend");}

    expect(yield* detectStuckWorkers(store, () => true)).toBe(0);
    expect(yield* store.read(`SELECT * FROM operator_hold WHERE closed_at IS NULL`)).toEqual([]);
    expect(yield* store.read(`SELECT status FROM message WHERE id IN (SELECT message_id FROM message_attempt)`))
      .toEqual(Array.from({ length: 6 }, () => ({ status: "bound" })));
    const [fresh] = yield* scheduler(store).schedule();

    if (fresh === undefined) {throw new Error("no fresh assignment");}

    // Simulate an old version's rearmed copies to prove the attempt transaction independently
    // checks obligations, not merely reconciliation's decision. Binding/attempt evidence stays.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET status = 'bound' WHERE id IN (SELECT message_id FROM message_attempt)`);
      yield* change.query(`UPDATE message SET status = 'bound', bound_slot = 'worker/1', bound_at = 2 WHERE id = ?`, [fresh.contextMessage]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "rearmed" });
    }));
    const next = pump();
    const delivered: Array<DaemonFrame> = [];
    yield* Effect.promise(async () => {
      try {
        for (const slot of claimed) {next.attach(slot, { send: async (frame) => { delivered.push(frame); } });}

        await next.idle();
      } finally {await next.stop();}
    });
    expect(delivered.some((frame) => frame.type === "message" && oldIds.has(frame.id))).toBe(false);
    expect(delivered).toContainEqual(expect.objectContaining({ type: "message", id: fresh.contextMessage }));
    const afterAttempts = yield* store.read<{ message_id: string }>(`SELECT * FROM message_attempt ORDER BY rowid`);
    expect(afterAttempts.filter((attempt) => oldIds.has(attempt.message_id))).toEqual(unretired);
    expect(errors).toEqual([]);
  }));
});

test("assigned retry reserves capacity, serializes operator actions, and refuses stale identity", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    yield* service(store, root).submit({ title: "Next plan", spec: "Disposable" });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'frozen' WHERE slot_id != 'worker/1'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "capacity" });
    }));
    const before = yield* snapshot(store);
    let acknowledge!: () => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const settled = new Promise<void>((resolve) => { acknowledge = resolve; });

    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)],
      interrupter: { interrupt: async (slot, factory) => {
        expect([slot, factory]).toEqual(["worker/1", "shop"]);
        started();
        await settled;

        return { launchId: "launch-1", outcome: "aborted", slot: { factoryId: "shop", slotId: slot,
          station: "worker", ordinal: 1, condition: "normal", freezeCause: null, launch: null } };
      } } });

    const retrying = Effect.runPromise(tickets.retry("shop", 1).pipe(Effect.flip));
    yield* Effect.promise(() => called);
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* tickets.pause("shop", 1).pipe(Effect.flip)).toMatchObject({ code: "invalid_state" });
    const cancellation = yield* tickets.inspectCancellation("shop", 1);
    expect(yield* tickets.cancel("shop", 1, cancellation.confirmation).pipe(Effect.flip)).toMatchObject({ code: "invalid_state" });
    // A worker outcome racing with interrupt invalidates the retry's retained identity/state.
    yield* block(store, id);
    const blocked = yield* snapshot(store);
    // The outcome released durable capacity, but the interrupt reservation still prevents
    // a successor from starting before the old worker acknowledges settlement.
    expect(yield* scheduler(store).schedule()).toEqual([]);
    acknowledge();
    const result = yield* Effect.promise(() => retrying);
    expect(result).toMatchObject({ code: "invalid_state" });
    expect(yield* snapshot(store)).toEqual(blocked);
    expect(yield* scheduler(store).schedule()).toMatchObject([{ ticket: 2, slotId: "worker/1" }]);
  }));
});

test("interrupt failures and transaction failure preserve all obligations", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    yield* obligations(store);
    const before = yield* snapshot(store);
    expect(yield* service(store, root).retry("shop", 1).pipe(Effect.flip)).toMatchObject({ code: "unavailable" });

    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)],
      interrupter: { interrupt: async () => { throw new SlotsError("interrupt_unacknowledged", "No acknowledgement"); } } });

    expect(yield* tickets.retry("shop", 1).pipe(Effect.flip)).toMatchObject({ code: "interrupt_unacknowledged" });
    expect(yield* snapshot(store)).toEqual(before);
    yield* block(store, id);
    const blocked = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))) };

    expect(yield* service(failing, root).retry("shop", 1).pipe(Effect.flip)).toMatchObject({ message: "commit failure" });
    expect(yield* snapshot(store)).toEqual(blocked);
  }));
});

test("CLI/API retry on a parked slot succeeds without interrupt; hook-failure pause refuses", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    yield* block(store, id);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'parked' WHERE slot_id = 'worker/1'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "parked" });
    }));
    yield* Effect.promise(async () => {
      const api = await serveManagementApi({ stateRoot: root, tickets: service(store, root), status: () => ({
        instance: { stateRoot: root, daemonPid: 1, startedAt: new Date(0).toISOString() },
      }) });

      try {
        const result = await runTicketRetry({ home: root, factory: "shop", number: 1, json: true, env: {} });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { ticket: { status: "queued" } } });
      } finally {await api.close();}
    });
    expect(yield* scheduler(store).schedule()).toMatchObject([{ slotId: "worker/2" }]);
    const tickets = service(store, root);
    yield* tickets.submit({ title: "Failed hook", spec: "Disposable" });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET state = 'stage', stage = 'plan', status = 'paused' WHERE number = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "hook-failed" });
    }));
    const before = yield* snapshot(store);
    expect(yield* tickets.retry("shop", 2).pipe(Effect.flip)).toMatchObject({ code: "invalid_state" });
    expect(yield* tickets.retry("shop", 999).pipe(Effect.flip)).toMatchObject({ code: "ticket_not_found" });
    expect(yield* snapshot(store)).toEqual(before);
  }));
});
