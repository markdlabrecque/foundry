// Integration tier: disposable SQLite proves ownership, atomic submissions and a durable queue.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import {
  agentDelegateHandler, createAssignmentScheduler, createSubmissions, createTicketService, openStore, planSlots,
  StoreError, taskTransitionHandler, ticketFactoryFrom, serveManagementApi, storeApprovalsReader,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { TASK_TRANSITION } from "@foundry/protocol";
import { runApprovalList, runApprovalShow } from "@foundry/cli";
import { FactoryConfig } from "../src/config/schema.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard",
  rooms: { floor: { stations: { worker: {}, reviewer: { isolation: "worktree" } } } },
  production_lines: { standard: { stages: [
    { id: "plan", station: "floor.worker" },
    { id: "implement", station: "floor.reviewer", writing: true },
    { id: "review", station: "floor.reviewer", approval: true, on_rejection: "implement" },
  ] } },
});

const slots = planSlots("shop", [{
  address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 2, isolation: "none",
}]);

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const schedulerOptions = (store: Store) => ({ store, slots, factories: [{ factoryId: "shop", config }] });

const handlers = new Map([[TASK_TRANSITION, taskTransitionHandler({
  factories: [{ factoryId: "shop", config }], configLoad: () => "load-1",
})]]);

const owner = { factoryId: "shop", slotId: "worker/1", launchId: "launch-1" };

const frame = (assignmentId: string) => ({ type: "tool_call", tool: TASK_TRANSITION, callId: "done-1",
  args: { assignmentId, outcome: "done", reason: "Plan ready", evidence: ["evidence/plan.md"], gitCommit: "evaluated-commit" },
} as const);

const snapshot = (store: Store) => Effect.all({
  tickets: store.read(`SELECT * FROM ticket`), assignments: store.read(`SELECT * FROM assignment`),
  transitions: store.read(`SELECT * FROM ticket_transition`), history: store.read(`SELECT * FROM history`),
  submissions: store.read(`SELECT * FROM submission`), messages: store.read(`SELECT * FROM message`),
  approvals: store.read(`SELECT * FROM approval`),
});

const fixture = async <A, E>(use: (store: Store, assignmentId: string, root: string) => Effect.Effect<A, E>) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-transition-"));
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
      .submit({ title: "Plan", spec: "Disposable spec" }).pipe(Effect.orDie);
    const assigned = yield* createAssignmentScheduler(schedulerOptions(store)).schedule();
    const id = assigned[0]?.id;

    if (id === undefined) {throw new Error("fixture did not assign");}

    return yield* use(store, id, root);
  })));
};

test("done commits evidence, ended assignment and queued next stage; replay and restart preserve it", async () => {
  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers });
    const before = yield* snapshot(store);
    const result = yield* Effect.promise(() => submissions.submit(owner, frame(id)));
    expect(result).toEqual({ status: "committed", value: { assignmentId: id, ticket: 1, stage: "implement", status: "queued" } });
    const after = yield* snapshot(store);
    expect(after.tickets).toMatchObject([{ state: "stage", stage: "implement", status: "queued" }]);
    expect(after.assignments).toMatchObject([{ id, status: "ended", ended_at: expect.any(Number), end_reason: "done" }]);
    expect(after.assignments).toHaveLength(1); // No inline scheduling.
    expect(after.messages).toEqual(before.messages);
    expect(after.transitions).toHaveLength(before.transitions.length + 1);
    expect(after.transitions.at(-1)).toMatchObject({ actor: "worker/1", from_state: "stage", from_stage: "plan",
      from_status: "assigned", to_state: "stage", to_stage: "implement", to_status: "queued", outcome: "done",
      reason: "Plan ready", git_commit: "evaluated-commit", evidence: '["evidence/plan.md"]', config_load: "load-1" });
    expect(after.submissions).toHaveLength(1);
    expect(yield* Effect.promise(() => submissions.submit(owner, frame(id)))).toEqual(result);
    expect(yield* snapshot(store)).toEqual(after);
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), callId: "new-call" })))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    expect(yield* snapshot(store)).toEqual(after);

    return { root, after };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    // Worktree readiness is a separate boundary: absent code-stage capacity leaves the queue intact.
    expect(yield* createAssignmentScheduler(schedulerOptions(store)).schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(saved.after);
  })));
});

test("different slots/factories, suspended assignments, missing IDs and worker destinations cannot advance", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers });
    const before = yield* snapshot(store);

    for (const identity of [{ ...owner, slotId: "worker/2" }, { ...owner, factoryId: "other" }]) {
      expect(yield* Effect.promise(() => submissions.submit(identity, frame(id))))
        .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    }

    for (const args of [
      { ...frame(id).args, destination: "review" }, { ...frame(id).args, stage: "review" },
      { ...frame(id).args, ticket: 99 }, { ...frame(id).args, outcome: "unknown" },
      { ...frame(id).args, reason: "" }, { ...frame(id).args, evidence: [""] },
    ]) {
      expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args })))
        .toMatchObject({ status: "refused", code: "invalid_arguments" });
    }

    expect(yield* Effect.promise(() => submissions.submit(owner, frame("missing"))))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    expect(yield* snapshot(store)).toEqual(before);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'suspended' WHERE id = ?`, [id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "suspended" });
    }));
    const suspended = yield* snapshot(store);
    expect(yield* Effect.promise(() => submissions.submit(owner, frame(id))))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    expect(yield* snapshot(store)).toEqual(suspended);
  }));
});

test("new delegation acceptance cannot strand open work under an ended assignment", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    yield* store.change((change) => agentDelegateHandler(slots)(change, {
      ...owner, callId: "delegate", tool: "agent_delegate", args: { recipient: "floor.worker", body: "Help with plan" },
    }));
    const before = yield* snapshot(store);
    const delegations = yield* store.read(`SELECT * FROM delegation`);
    expect(delegations).toHaveLength(1);
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
      .toMatchObject({ status: "refused", code: "open_delegations" });
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* store.read(`SELECT * FROM delegation`)).toEqual(delegations);
  }));
});

test("failure after handler writes rolls back outcome, assignment, history and submission together", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    expect(yield* Effect.promise(() => createSubmissions({ store: failing, handlers }).submit(owner, frame(id))))
      .toMatchObject({ status: "refused", code: "not_committed" });
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
      .toMatchObject({ status: "committed" });
  }));
});

test.each([
  { label: "non-final approval", approval: true, writing: false, station: "floor.worker" },
  { label: "writing", approval: false, writing: true, station: "floor.worker" },
  { label: "non-writing worktree", approval: false, writing: false, station: "floor.reviewer" },
])("$label guard independently refuses without effects", async ({ approval, writing, station }) => {
  await fixture((store, id) => Effect.gen(function* () {
    // Structural fixtures isolate each guard; writing/non-worktree is deliberately not a valid
    // loadable production line, but still must not bypass the handler's writing-stage guard.
    const guardedConfig = { ...config, production_lines: { standard: {
      ...config.production_lines.standard,
      stages: [{ id: "plan", station, approval, writing }, { id: "next", station: "floor.worker", approval: false, writing: false }],
    } } };

    const guardedHandlers = new Map([[TASK_TRANSITION, taskTransitionHandler({ factories: [{ factoryId: "shop", config: guardedConfig }] })]]);
    const before = yield* snapshot(store);
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers: guardedHandlers }).submit(owner, frame(id))))
      .toMatchObject({ status: "refused", code: "unsupported_transition" });
    expect(yield* snapshot(store)).toEqual(before);
  }));
});

test.each(["blocked", "rejected"] as const)("%s pauses atomically, frees capacity and survives replay/restart with its true outcome", async (outcome) => {
  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    // Pausing preserves open delegated work and assignment-local recovery allowances.
    yield* store.change((change) => agentDelegateHandler(slots)(change, {
      ...owner, callId: "delegate", tool: "agent_delegate", args: { recipient: "floor.worker", body: "Help" },
    }));
    const delegations = yield* store.read(`SELECT * FROM delegation`);
    const before = yield* snapshot(store);
    const submissions = createSubmissions({ store, handlers });
    const call = { ...frame(id), args: { ...frame(id).args, outcome, reason: "Need operator input" } };

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    expect(yield* Effect.promise(() => createSubmissions({ store: failing, handlers }).submit(owner, call)))
      .toMatchObject({ status: "refused", code: "not_committed" });
    expect(yield* snapshot(store)).toEqual(before);

    for (const identity of [{ ...owner, slotId: "worker/2" }, { ...owner, factoryId: "other" }]) {
      expect(yield* Effect.promise(() => submissions.submit(identity, call)))
        .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    }

    const result = yield* Effect.promise(() => submissions.submit(owner, call));
    expect(result).toMatchObject({ status: "committed", value: { status: "paused", stage: "plan", approvalId: expect.any(Number) } });
    const after = yield* snapshot(store);
    expect(after.tickets).toMatchObject([{ stage: "plan", status: "paused", rejections: 0 }]);
    expect(after.assignments).toEqual(before.assignments.map((a) => ({ ...a, status: "suspended" })));
    expect(yield* store.read(`SELECT * FROM delegation`)).toEqual(delegations);
    expect(after.messages).toEqual(before.messages);
    expect(after.transitions).toHaveLength(before.transitions.length + 1);
    expect(after.transitions.at(-1)).toMatchObject({ from_stage: "plan", to_stage: "plan", to_status: "paused", outcome,
      actor: "worker/1", reason: "Need operator input", git_commit: "evaluated-commit",
      evidence: '["evidence/plan.md"]', config_load: "load-1" });
    expect(after.approvals).toMatchObject([{ kind: "blocked", state: "open", assignment_id: id }]);
    expect(yield* Effect.promise(() => submissions.submit(owner, call))).toEqual(result);
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...call, callId: "stale" })))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    expect(yield* snapshot(store)).toEqual(after);

    // Exercise the single real SQLite -> socket boundary through the operator CLI cores.
    yield* Effect.promise(async () => {
      const api = await serveManagementApi({ stateRoot: root, status: () => ({ instance: {
        stateRoot: root, daemonPid: 1, startedAt: new Date(0).toISOString(),
      } }), approvals: storeApprovalsReader(store) });

      try {
        const options = { home: root, env: {}, json: false };
        const list = await runApprovalList(options);
        expect(list.exitCode).toBe(0);
        expect(list.stdout).toContain("blocked  shop  ticket 1  plan  Need operator input");
        const shown = await runApprovalShow({ ...options, id: "1" });
        expect(shown.exitCode).toBe(0);
        expect(shown.stdout).toContain(`outcome     ${outcome}`);
        expect(shown.stdout).toContain("evidence/plan.md");

        for (const verb of ["resume", "retry", "cancel"]) {
          expect(shown.stdout).toContain(`foundry ticket ${verb} 1 --factory 'shop'`);
        }

        const json = await runApprovalShow({ ...options, id: "1", json: true });
        expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, result: { approval: {
          kind: "blocked", outcome, reason: "Need operator input", assignmentId: id, configLoad: "load-1",
        } } });
        expect((await runApprovalShow({ ...options, id: "999" })).exitCode).toBe(1);
        expect((await runApprovalShow({ ...options, id: "0" })).exitCode).toBe(2);
      } finally {await api.close();}
    });

    // The scheduler can use the freed slot, but must not reschedule the paused ticket.
    yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] })
      .submit({ title: "Next plan", spec: "Next disposable spec" }).pipe(Effect.orDie);
    const next = yield* createAssignmentScheduler(schedulerOptions(store)).schedule();
    expect(next).toMatchObject([{ ticket: 2, slotId: "worker/1" }]);

    return { root, after: yield* snapshot(store) };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    expect((yield* Effect.promise(() => storeApprovalsReader(store).list())).approvals).toMatchObject([{ outcome, state: "open" }]);
  })));
});

test("blocked works at final and code stages without requiring a destination; routed rejection stays out of scope", async () => {
  for (const stage of ["implement", "review"]) {
    await fixture((store, id) => Effect.gen(function* () {
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET stage = ?`, [stage]);
        yield* change.query(`UPDATE assignment SET stage = ?`, [stage]);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: stage });
      }));
      const submissions = createSubmissions({ store, handlers });

      if (stage === "review") {
        const before = yield* snapshot(store);
        expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, outcome: "rejected" } })))
          .toMatchObject({ status: "refused", code: "unsupported_transition" });
        expect(yield* snapshot(store)).toEqual(before);
      }

      expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, outcome: "blocked" } })))
        .toMatchObject({ status: "committed", value: { stage, status: "paused" } });
    }));
  }
});

test("adjacent approval/code/final workflows fail closed without effects", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    for (const stage of ["implement", "review"]) {
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET stage = ?`, [stage]);
        yield* change.query(`UPDATE assignment SET stage = ?`, [stage]);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: stage });
      }));
      const before = yield* snapshot(store);
      expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
        .toMatchObject({ status: "refused", code: "unsupported_transition" });
      expect(yield* snapshot(store)).toEqual(before);
    }
  }));
});
