// Integration tier: disposable SQLite proves ownership, atomic submissions and a durable queue.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Effect, Exit, Match, Schema } from "effect";
import {
  acceptMessage, agentDelegateHandler, agentRequestHandler, assignmentTicket, createAssignmentScheduler, createSubmissions, createTicketService, openStore, planSlots,
  createFactorySyncer, enqueueOperation, listOperations, startNextOperation,
  createApprovalAnswers, humanRequestHandler, createApprovalDecisions, createOperatorMessages, foundryMigrations, messageBudget, StoreError, taskTransitionHandler, ticketFactoryFrom, serveManagementApi, storeApprovalsReader,
} from "@foundry/daemon";
import type { Migration, SqlValue, Store } from "@foundry/daemon";
import { HUMAN_REQUEST, TASK_TRANSITION } from "@foundry/protocol";
import { expectDefined } from "@foundry/protocol/errors";
import { runApprovalAnswer, runApprovalDecision, runApprovalList, runApprovalShow, runTicketCancel } from "@foundry/cli";
import { git as fixtureGit, isolatedGitEnv, makeGitSource } from "@foundry/testkit";
import { FactoryConfig } from "../src/config/schema.js";
import { getFromDaemon, postToDaemon } from "../../cli/src/management-client.js";
import { approvalAnswerPath } from "@foundry/protocol/approvals";
import { loadFactoryFiles, LoadFactoriesResult, voidStaleApprovals } from "@foundry/daemon";
import { createWorktreeService } from "../src/worktree-cleanup.js";

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
const byteFilename = (directory: string) => Buffer.concat([Buffer.from(`${directory}/`), Buffer.from([0xff]), Buffer.from(".txt")]);

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
}).trim();

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
  transitions: store.read(`SELECT * FROM ticket_transition`).pipe(Effect.map((rows) => rows.map((row) => ({ voided_transitions: "[]", ...row })))),
  history: store.read(`SELECT * FROM history`),
  submissions: store.read(`SELECT * FROM submission`), messages: store.read(`SELECT * FROM message`),
  approvals: store.read(`SELECT * FROM approval`),
  requests: store.read(`SELECT * FROM agent_request`),
  operations: store.read(`SELECT * FROM operation`),
  delegations: store.read(`SELECT * FROM delegation ORDER BY accepted_at, rowid`),
});

const fixture = async <A, E>(use: (store: Store, assignmentId: string, root: string) => Effect.Effect<A, E>, migrations = foundryMigrations) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-transition-"));
  roots.push(root);

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db"), migrations });
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of slots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition)
          VALUES ('shop', ?, 'worker', ?, 'normal')`, [slot.slotId, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
    }));
    yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] })
      .submit({ title: "Plan", spec: "Disposable spec" }).pipe(Effect.orDie);

    if (migrations === foundryMigrations) {
      const assigned = yield* createAssignmentScheduler(schedulerOptions(store)).schedule();
      const id = assigned[0]?.id;

      if (id === undefined) {throw new Error("fixture did not assign");}

      return yield* use(store, id, root);
    }

    // Historical schemas predate resume tables; seed their original assignment shape rather
    // than calling today's scheduler against a database it has not migrated yet.
    const id = 'historical-assignment';
    yield* store.change((change) => Effect.gen(function* () {
      const context = yield* acceptMessage(change, { factoryId: 'shop', senderKind: 'daemon', senderSlot: null,
        recipient: 'floor.worker', body: 'historical context', kind: 'ordinary', delivery: 'after_turn', correlation: { ticket: 1 } });

      yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
        VALUES (?, 'shop', 1, 'plan', 'worker/1', 'active', 3, 1, ?)`, [id, context.id]);
      yield* change.query(`UPDATE ticket SET state = 'stage', stage = 'plan', status = 'assigned' WHERE number = 1`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: id });
    }));

    return yield* use(store, id, root);
  })));
};

test("cancel atomically ends a blocked assignment, its whole obligation tree and approval, retaining Git and artifacts", async () => {
  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    const clone = join(root, "clone");
    const start = makeGitSource(clone);
    const worktree = join(root, "ticket-worktree");
    fixtureGit(clone, ["worktree", "add", "-b", "ticket-1", worktree]);
    writeFileSync(join(worktree, "untracked.txt"), "keep untracked work");
    const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)], configLoad: () => "cancel-load" });
    const detail = yield* service.show("shop", 1);
    const evidence = join(detail.ticket.evidencePath, "result.txt");
    writeFileSync(evidence, "keep evidence");
    const delegate = agentDelegateHandler(slots);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'ticket-1', start_commit = ? WHERE number = 1`, [worktree, start]);
      yield* delegate(change, { ...owner, callId: "parent", tool: "agent_delegate", args: { recipient: "floor.worker", body: "Parent work" } });
      const [parent] = yield* change.query<{ id: string }>(`SELECT id FROM delegation`);

      if (parent === undefined) {throw new Error("missing parent");}

      yield* change.query(`UPDATE delegation SET recipient_slot = 'worker/2' WHERE id = ?`, [parent.id]);
      yield* delegate(change, { ...owner, slotId: "worker/2", callId: "child", tool: "agent_delegate",
        args: { recipient: "floor.worker", body: "Nested work", parentDelegationId: parent.id } });
      yield* agentRequestHandler(slots, { assignmentTicket })(change, { ...owner, callId: "request", tool: "agent_request",
        args: { recipient: "floor.worker", body: "Open question", timeoutMs: 60_000 } });
    }));
    const submissions = createSubmissions({ store, handlers });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, outcome: "blocked", gitCommit: start } })))
      .toMatchObject({ status: "committed" });
    const before = yield* snapshot(store);
    const inspection = yield* service.inspectCancellation("shop", 1);
    expect(inspection.requests).toHaveLength(1);
    expect(inspection.delegations).toHaveLength(2);
    const result = yield* service.cancel("shop", 1, inspection.confirmation);
    const after = yield* snapshot(store);
    expect(result.ticket).toMatchObject({ state: "cancelled", stage: null, status: null,
      worktree: { path: worktree, branch: "ticket-1", startCommit: start } });
    expect(after.assignments).toMatchObject([{ id, status: "ended", end_reason: "cancelled", ended_at: expect.any(Number) }]);
    expect(after.delegations).toMatchObject([{ status: "cancelled" }, { status: "cancelled" }]);
    expect(after.requests).toMatchObject([{ status: "cancelled" }]);
    expect(after.approvals).toMatchObject([{ state: "resolved", closed_at: expect.any(Number) }]);
    expect(after.operations).toEqual(before.operations); // No worktree cleanup was even queued.
    expect(result.transitions).toHaveLength(before.transitions.length + 1);
    expect(result.transitions.at(-1)).toMatchObject({ actor: "operator", from: { state: "stage", stage: "plan", status: "paused" },
      to: { state: "cancelled", stage: null, status: null }, configLoad: "cancel-load" });
    expect(fixtureGit(clone, ["rev-parse", "ticket-1"])).toBe(start);
    expect(fixtureGit(clone, ["worktree", "list", "--porcelain"])).toContain(worktree);
    expect(readFileSync(join(worktree, "untracked.txt"), "utf8")).toBe("keep untracked work");
    expect(readFileSync(evidence, "utf8")).toBe("keep evidence");
    expect(readFileSync(detail.ticket.specPath, "utf8")).toBe("Disposable spec");
    expect(yield* createAssignmentScheduler(schedulerOptions(store)).schedule()).toEqual([]);
    expect(Exit.isFailure(yield* Effect.exit(service.cancel("shop", 1, inspection.confirmation)))).toBe(true);
    expect(yield* snapshot(store)).toEqual(after);

    return { root, after };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
  })));
});

test("cancel resolves worker and message-limit approvals without granting another allowance", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers: new Map([[HUMAN_REQUEST, humanRequestHandler]]) });
    yield* Effect.promise(() => submissions.submit(owner, { type: "tool_call", tool: HUMAN_REQUEST, callId: "decision-before-cancel",
      args: { assignmentId: id, body: "Keep waiting for an operator" } }));
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET message_ceiling = 1 WHERE factory_id = 'shop' AND number = 1`);
      yield* agentRequestHandler(slots, { assignmentTicket, budget: messageBudget() })(change,
        { ...owner, callId: "last-message", tool: "agent_request", args: { recipient: "floor.worker", body: "Budget boundary", timeoutMs: 60_000 } });
    }));
    expect(yield* store.read(`SELECT kind, state FROM approval ORDER BY id`))
      .toEqual([{ kind: "worker_request", state: "open" }, { kind: "limit_reached", state: "open" }]);
    const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
    const inspection = yield* service.inspectCancellation("shop", 1);
    const result = yield* service.cancel("shop", 1, inspection.confirmation);
    expect(result.ticket).toMatchObject({ state: "cancelled", messages: { spent: 1, ceiling: 1 } });
    expect(yield* store.read(`SELECT kind, state FROM approval ORDER BY id`))
      .toEqual([{ kind: "worker_request", state: "resolved" }, { kind: "limit_reached", state: "resolved" }]);
    expect(yield* store.read(`SELECT status FROM agent_request`)).toEqual([{ status: "cancelled" }]);
    expect(yield* Effect.promise(() => storeApprovalsReader(store).list())).toEqual({ approvals: [] });
  }));
});

test("cancel waits for active worker settlement; failed commit rolls back every cancellation write", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    const base = { store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] };
    yield* store.change((change) => Effect.gen(function* () {
      yield* agentDelegateHandler(slots)(change, { ...owner, tool: "agent_delegate", callId: "open-delegation",
        args: { recipient: "floor.worker", body: "Keep open on rollback" } });
      yield* agentRequestHandler(slots, { assignmentTicket })(change, { ...owner, tool: "agent_request", callId: "open-request",
        args: { recipient: "floor.worker", body: "Keep request on rollback", timeoutMs: 60_000 } });
    }));
    const before = yield* snapshot(store);
    let interrupts = 0;

    const interrupter = { interrupt: async () => {
      interrupts += 1;
      expect(await Effect.runPromise(snapshot(store))).toEqual(before);

      return { launchId: "launch-1", outcome: "aborted" as const,
        slot: { factoryId: "shop", slotId: "worker/1", station: "floor.worker", ordinal: 1,
          condition: "normal" as const, freezeCause: null, launch: null } };
    } };

    const failing: Store = { ...store, change: (body) => store.change((change) => Effect.flatMap(body(change),
      () => Effect.fail(new StoreError({ reason: "Sql", message: "injected commit failure" })))) };

    const broken = createTicketService({ ...base, store: failing, interrupter });
    const inspected = yield* broken.inspectCancellation("shop", 1);
    expect(Exit.isFailure(yield* Effect.exit(broken.cancel("shop", 1, inspected.confirmation)))).toBe(true);
    expect(interrupts).toBe(1);
    expect(yield* snapshot(store)).toEqual(before);
    const service = createTicketService({ ...base, interrupter });
    yield* service.cancel("shop", 1, inspected.confirmation);
    expect(interrupts).toBe(2);
    expect(yield* store.read(`SELECT status, end_reason FROM assignment WHERE id = ?`, [id]))
      .toEqual([{ status: "ended", end_reason: "cancelled" }]);
  }));
});

test("cancel reserves slot capacity across settlement and refuses to interrupt a successor from a stale snapshot", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    const options = { store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] };
    const tickets = createTicketService(options);
    yield* tickets.submit({ title: "Second", spec: "occupy worker/2" });
    yield* createAssignmentScheduler(schedulerOptions(store)).schedule();
    yield* tickets.submit({ title: "Successor", spec: "wait for worker/1" });
    const inspection = yield* tickets.inspectCancellation("shop", 1);
    const submissions = createSubmissions({ store, handlers });
    let interrupts = 0;

    const service = createTicketService({ ...options, interrupter: { interrupt: async () => {
      interrupts += 1;
      expect(await submissions.submit(owner, frame(id))).toMatchObject({ status: "committed" });
      // The old outcome ended the root, but cancellation still owns capacity until it settles.
      expect(await Effect.runPromise(createAssignmentScheduler(schedulerOptions(store)).schedule())).toEqual([]);

      return { launchId: "launch-1", outcome: "idle" as const,
        slot: { factoryId: "shop", slotId: "worker/1", station: "floor.worker", ordinal: 1,
          condition: "normal" as const, freezeCause: null, launch: null } };
    } } });

    expect(Exit.isFailure(yield* Effect.exit(service.cancel("shop", 1, inspection.confirmation)))).toBe(true);
    expect(interrupts).toBe(1);
    const assigned = yield* createAssignmentScheduler(schedulerOptions(store)).schedule();
    expect(assigned).toMatchObject([{ ticket: 3, slotId: "worker/1" }]);

    // The same launch/slot now belongs to a different ticket; an old confirmation never aborts it.
    expect(Exit.isFailure(yield* Effect.exit(service.cancel("shop", 1, inspection.confirmation)))).toBe(true);
    expect(interrupts).toBe(1);
    expect((yield* tickets.show("shop", 3)).ticket.status).toBe("assigned");
  }));
});

test("cancel refuses failed interrupts and stale disclosures without ending work", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)],
      interrupter: { interrupt: async () => { throw new Error("worker unavailable"); } } });

    const before = yield* snapshot(store);
    const inspection = yield* service.inspectCancellation("shop", 1);
    expect(Exit.isFailure(yield* Effect.exit(service.cancel("shop", 1, inspection.confirmation)))).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);
    yield* store.change((change) => agentDelegateHandler(slots)(change, { ...owner, tool: "agent_delegate", callId: "new-work",
      args: { recipient: "floor.worker", body: "New work after disclosure" } }));
    const changed = yield* snapshot(store);
    expect(Exit.isFailure(yield* Effect.exit(service.cancel("shop", 1, inspection.confirmation)))).toBe(true);
    expect(yield* snapshot(store)).toEqual(changed);
    expect(changed.assignments).toMatchObject([{ id, status: "active" }]);
  }));
});

test("ticket cancel CLI discloses, refuses nonterminal use without --yes, and cancels backlog through the API", async () => {
  await fixture((store, _id, root) => Effect.gen(function* () {
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
    yield* tickets.submit({ title: "Backlog", spec: "Keep this" });

    const api = yield* Effect.promise(() => serveManagementApi({ stateRoot: root, tickets,
      status: () => ({ instance: { stateRoot: root, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } }) }));

    try {
      const notices: Array<string> = [];

      const options = { number: 2, home: root, factory: "shop", env: {}, json: true, yes: false, terminal: false,
        notice: (text: string) => { notices.push(text); } };

      const before = yield* snapshot(store);
      expect(yield* Effect.promise(() => runTicketCancel(options))).toMatchObject({ exitCode: 2 });
      expect(yield* snapshot(store)).toEqual(before);
      expect(yield* Effect.promise(() => runTicketCancel({ ...options, terminal: true, confirm: async () => false }))).toMatchObject({ exitCode: 2 });
      const result = yield* Effect.promise(() => runTicketCancel({ ...options, yes: true }));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { ticket: { state: "cancelled" } } });
      expect(notices.join("\n")).toContain("Worktree kept: none");
      expect((yield* tickets.show("shop", 1)).ticket.status).toBe("assigned");
    } finally {yield* Effect.promise(() => api.close());}
  }));
});

test("rejection limit migration preserves blocked and worker request approvals and their constraints", async () => {
  const previousMigrations = foundryMigrations.slice(0, foundryMigrations.findIndex((migration) => migration.name === "message_limit_approvals"));

  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers: new Map([...handlers, [HUMAN_REQUEST, humanRequestHandler]]) });
    yield* Effect.promise(() => submissions.submit(owner, { type: "tool_call", tool: HUMAN_REQUEST,
      callId: "request-before-upgrade", args: { assignmentId: id, body: "Choose an option" } }));
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id),
      args: { ...frame(id).args, outcome: "blocked" } }));

    return { root, after: yield* snapshot(store) };
  }), previousMigrations);

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    const expected = { ...saved.after, approvals: saved.after.approvals.map((approval) => ({ ...approval, decision: null, resolution_transition: null })) };
    expect(yield* snapshot(store)).toEqual(expected);
    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);
    expect(yield* Effect.promise(() => storeApprovalsReader(store).list())).toMatchObject({ approvals: [
      { id: 1, kind: "worker_request", reason: "Choose an option", transition: null },
      { id: 2, kind: "blocked", outcome: "blocked" },
    ] });

    const invalid = yield* Effect.exit(store.change((change) => Effect.gen(function* () {
      yield* change.query(
        `INSERT INTO approval (factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at)
         SELECT factory_id, ticket_number, assignment_id, NULL, 'limit_reached', 'open', raised_at FROM approval WHERE id = 2`,
      );
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "invalid-approval" });
    })));

    expect(Exit.isFailure(invalid)).toBe(true);
    expect(yield* snapshot(store)).toEqual(expected);
  })));
});

test("CLI answer commits one resolution and an exact-slot budget-exempt answer, or neither", async () => {
  await fixture((store, id, root) => Effect.scoped(Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers: new Map([[HUMAN_REQUEST, humanRequestHandler]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { type: "tool_call", tool: HUMAN_REQUEST,
      callId: "request", args: { assignmentId: id, body: "Which option?" } })))
      .toMatchObject({ status: "committed", value: { approvalId: 1 } });
    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    expect(Exit.isFailure(yield* Effect.exit(createApprovalAnswers(failing, slots).answer(1, "Use B")))).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);
    expect(Exit.isFailure(yield* Effect.exit(createApprovalAnswers(store, []).answer(1, "Use B")))).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);

    const api = yield* Effect.promise(() => serveManagementApi({ stateRoot: root,
      approvalAnswers: createApprovalAnswers(store, slots),
      status: () => ({ instance: { stateRoot: root, daemonPid: 1, startedAt: "2026-01-01T00:00:00Z" } }),
    }));

    yield* Effect.addFinalizer(() => Effect.promise(api.close));

    for (const body of [{}, { body: "" }, { body: 5 }]) {
      expect((yield* Effect.promise(() => postToDaemon(root, approvalAnswerPath(1), body))).status).toBe(400);
    }

    const options = { home: root, env: {}, json: false, id: "1", body: "Use B\n✓" };
    const outcomes = yield* Effect.promise(() => Promise.all([runApprovalAnswer(options), runApprovalAnswer({ ...options, json: true })]));
    expect(outcomes.map((o) => o.exitCode).sort((a, b) => a - b)).toEqual([0, 1]);
    const after = yield* snapshot(store);
    expect(after.approvals).toMatchObject([{ state: "resolved", closed_at: expect.any(Number) }]);
    expect(after.messages.slice(before.messages.length)).toMatchObject([{ factory_id: "shop", sender_kind: "operator",
      sender_slot: null, recipient: "floor.worker", body: options.body, ticket_number: 1,
      delivery: "after_turn", status: "bound", bound_slot: "worker/1" }]);
    expect(after.messages).toHaveLength(before.messages.length + 1);
    expect(after.tickets).toEqual(before.tickets); // Includes message_count and ceiling: no budget charged.
    expect(after.assignments).toEqual(before.assignments);
    expect(after.transitions).toEqual(before.transitions);
    expect(yield* store.read(`SELECT * FROM history WHERE kind = 'approval.answered'`)).toHaveLength(1);
    expect((yield* Effect.promise(() => runApprovalAnswer(options))).exitCode).toBe(1);
    expect((yield* Effect.promise(() => runApprovalAnswer({ ...options, id: "999" }))).exitCode).toBe(1);

    for (const invalid of [{ id: "0" }, { id: "9007199254740992" }, { body: "" }]) {
      expect((yield* Effect.promise(() => runApprovalAnswer({ ...options, ...invalid }))).exitCode).toBe(2);
    }

    expect(yield* snapshot(store)).toEqual(after);
  })));
});

test("human_request records one approval per submission, survives restart and never gates done", async () => {
  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    const requestHandlers = new Map([...handlers, [HUMAN_REQUEST, humanRequestHandler]]);
    const submissions = createSubmissions({ store, handlers: requestHandlers });
    const call = { type: "tool_call", tool: HUMAN_REQUEST, callId: "decision-1", args: { assignmentId: id, body: "Which option?" } } as const;
    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    expect(yield* Effect.promise(() => createSubmissions({ store: failing, handlers: requestHandlers }).submit(owner, call)))
      .toMatchObject({ status: "refused", code: "not_committed" });

    for (const identity of [{ ...owner, slotId: "worker/2" }, { ...owner, factoryId: "other" }]) {
      expect(yield* Effect.promise(() => submissions.submit(identity, call)))
        .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    }

    for (const args of [{ assignmentId: "missing", body: "Help" }, { assignmentId: id, body: "" },
      { assignmentId: id, body: "Help", stage: "review" }]) {
      expect(yield* Effect.promise(() => submissions.submit(owner, { ...call, args }))).toMatchObject({ status: "refused" });
    }

    expect(yield* snapshot(store)).toEqual(before);
    const result = yield* Effect.promise(() => submissions.submit(owner, call));
    expect(result).toEqual({ status: "committed", value: { approvalId: 1, assignmentId: id, ticket: 1 } });
    const after = yield* snapshot(store);
    expect(after.tickets).toEqual(before.tickets);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.transitions).toEqual(before.transitions);
    expect(after.approvals).toMatchObject([{ kind: "worker_request", state: "open", transition_sequence: null,
      request_body: "Which option?", request_stage: "plan", assignment_id: id }]);
    expect(after.history.slice(before.history.length)).toMatchObject([{ kind: "approval.requested" }, { kind: "submission.recorded" }]);
    expect(yield* Effect.promise(() => submissions.submit(owner, call))).toEqual(result);
    expect(yield* snapshot(store)).toEqual(after);
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...call, callId: "decision-2" })))
      .toMatchObject({ status: "committed", value: { approvalId: 2 } });
    expect(yield* store.read(`SELECT * FROM approval`)).toHaveLength(2);
    const reader = storeApprovalsReader(store);
    expect(yield* Effect.promise(() => reader.list())).toMatchObject({ approvals: [
      { kind: "worker_request", reason: "Which option?", stage: "plan", transition: null, outcome: null },
      { kind: "worker_request" },
    ] });
    expect(yield* Effect.promise(() => reader.show(1))).toMatchObject({ commands: ['foundry approval answer 1 "text"'] });
    expect(yield* Effect.promise(() => submissions.submit(owner, frame(id)))).toMatchObject({ status: "committed" });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...call, callId: "stale" })))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });

    return { root, after: yield* snapshot(store), call, result };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers: new Map([[HUMAN_REQUEST, humanRequestHandler]]) }).submit(owner, saved.call)))
      .toEqual(saved.result);
    expect(yield* snapshot(store)).toEqual(saved.after);
  })));
});

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
      reason: "Plan ready", git_commit: null, evidence: '["evidence/plan.md"]', config_load: "load-1" });
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

const routedConfig = { ...config, production_lines: { standard: {
  ...config.production_lines.standard,
  stages: [
    { id: "plan", station: "floor.worker", approval: false, writing: false },
    { id: "assess", station: "floor.worker", approval: true, writing: false, on_rejection: "plan" },
  ],
} } };

const routedHandlers = new Map([[TASK_TRANSITION, taskTransitionHandler({
  factories: [{ factoryId: "shop", config: routedConfig }], configLoad: () => "load-route",
})]]);

test.each(["resume", "retry", "cancel"] as const)("%s resolves a rejection-limit approval without resetting historical counts", async (action) => {
  const saved = await fixture((store, firstId, root) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers: routedHandlers });
    const scheduler = createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config: routedConfig }] });
    // An already-extended ceiling proves we add the current configured allowance, not reset it.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET rejections = 5, rejection_ceiling = 6`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "ceiling" });
    }));
    yield* Effect.promise(() => submissions.submit(owner, frame(firstId)));
    const assessment = (yield* scheduler.schedule())[0];

    if (assessment === undefined) {throw new Error("assessment not assigned");}

    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(assessment.id), callId: "reject-limit",
      args: { ...frame(assessment.id).args, outcome: "rejected" } }))).toMatchObject({ status: "committed" });
    const before = yield* snapshot(store);

    const factories = () => [ticketFactoryFrom({ ...routedConfig, production_lines: { standard: {
      ...routedConfig.production_lines.standard, rejection_limit: 2,
    } } })];

    const service = (target: Store) => createTicketService({ store: target, stateRoot: root, factories, configLoad: () => "grant-load" });

    const run = (target: Store) => Effect.gen(function* () {
      const tickets = service(target);

      return action === "cancel"
        ? yield* tickets.cancel("shop", 1, (yield* tickets.inspectCancellation("shop", 1)).confirmation)
        : yield* tickets[action]("shop", 1);
    });

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))) };

    expect(yield* run(failing).pipe(Effect.flip)).toMatchObject({ message: "commit failure" });
    expect(yield* snapshot(store)).toEqual(before);
    const result = yield* run(store);
    expect(result.ticket.rejections).toEqual({ spent: 6, ceiling: action === "cancel" ? 6 : 8 });
    expect(result.ticket.messages).toEqual({ spent: 0, ceiling: 100 });
    expect(result.ticket).toMatchObject(action === "cancel" ? { state: "cancelled" } : { stage: "plan", status: "queued" });
    const after = yield* snapshot(store);
    expect(after.approvals).toMatchObject([{ state: "resolved", closed_at: expect.any(Number) }]);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.transitions.slice(0, -1)).toEqual(before.transitions);
    expect(after.transitions).toHaveLength(before.transitions.length + 1);
    expect(after.transitions.at(-1)).toMatchObject({ actor: "operator", config_load: "grant-load" });

    if (action !== "cancel") {
      expect(result.transitions.at(-1)?.reason).toBe(`ticket ${action}; rejection ceiling raised from 6 to 8 (+2)`);
    }

    expect(yield* run(store).pipe(Effect.flip)).toMatchObject({ code: "invalid_state" });
    expect(yield* snapshot(store)).toEqual(after);

    return { root, after, oldId: assessment.id };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    const assigned = yield* createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config: routedConfig }] }).schedule();

    if (action === "cancel") {expect(assigned).toEqual([]);}
    else {
      expect(assigned).toMatchObject([{ ticket: 1, stage: "plan" }]);
      expect(assigned[0]?.id).not.toBe(saved.oldId);
      expect(yield* store.read(`SELECT rejections, rejection_ceiling FROM ticket`)).toEqual([{ rejections: 6, rejection_ceiling: 8 }]);
    }
  })));
});

test.each([1, 3])("routed rejection atomically pauses at ceiling %i, releases capacity and persists its approval", async (ceiling) => {
  const saved = await fixture((store, firstId, root) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers: routedHandlers });
    const scheduler = createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config: routedConfig }] });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET rejections = ?, rejection_ceiling = ?`, [ceiling - 1, ceiling]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "ceiling" });
    }));
    yield* Effect.promise(() => submissions.submit(owner, frame(firstId)));
    // Done never spends the rejection allowance.
    expect(yield* store.read(`SELECT rejections FROM ticket`)).toEqual([{ rejections: ceiling - 1 }]);
    const assessment = (yield* scheduler.schedule())[0];

    if (assessment === undefined) {throw new Error("assessment not assigned");}

    const rejection = { ...frame(assessment.id), callId: "limit-rejection",
      args: { ...frame(assessment.id).args, outcome: "rejected", reason: "Needs revision" } };

    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    expect(yield* Effect.promise(() => createSubmissions({ store: failing, handlers: routedHandlers }).submit(owner, rejection)))
      .toMatchObject({ status: "refused", code: "not_committed" });
    expect(yield* snapshot(store)).toEqual(before);
    const result = yield* Effect.promise(() => submissions.submit(owner, rejection));
    expect(result).toEqual({ status: "committed", value: { assignmentId: assessment.id, ticket: 1,
      stage: "plan", status: "paused", approvalId: 1 } });
    const after = yield* snapshot(store);
    expect(after.tickets).toMatchObject([{ stage: "plan", status: "paused", rejections: ceiling, rejection_ceiling: ceiling }]);
    expect(after.assignments.at(-1)).toMatchObject({ id: assessment.id, status: "ended", end_reason: "rejected", ended_at: expect.any(Number) });
    expect(after.assignments).toHaveLength(before.assignments.length);
    expect(after.transitions).toHaveLength(before.transitions.length + 1);
    expect(after.transitions.at(-1)).toMatchObject({ actor: owner.slotId, from_stage: "assess", from_status: "assigned",
      to_stage: "plan", to_status: "paused", outcome: "rejected", reason: "Needs revision",
      evidence: '["evidence/plan.md"]', config_load: "load-route" });
    expect(after.approvals).toMatchObject([{ kind: "limit_reached", state: "open", assignment_id: assessment.id,
      transition_sequence: expect.any(Number) }]);
    expect(yield* store.read(`SELECT a.id FROM approval a JOIN ticket_transition t ON t.sequence = a.transition_sequence
      WHERE a.kind = 'limit_reached' AND t.outcome = 'rejected' AND t.to_status = 'paused'`)).toEqual([{ id: 1 }]);
    expect(after.history.slice(before.history.length)).toMatchObject([
      { kind: "ticket.transitioned" }, { kind: "approval.requested" }, { kind: "submission.recorded" },
    ]);
    expect(yield* Effect.promise(() => submissions.submit(owner, rejection))).toEqual(result);
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...rejection, callId: "stale-limit" })))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(after);
    // A different ticket can claim the released slot; the paused ticket cannot run.
    yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(routedConfig)] })
      .submit({ title: "Other", spec: "Disposable spec" }).pipe(Effect.orDie);
    expect(yield* scheduler.schedule()).toMatchObject([{ ticket: 2, slotId: owner.slotId }]);

    return { root, after: yield* snapshot(store), rejection, result };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    const reader = storeApprovalsReader(store);
    expect(yield* Effect.promise(() => reader.list())).toMatchObject({ approvals: [{ kind: "limit_reached",
      outcome: "rejected", reason: "Needs revision", stage: "assess", evidence: ["evidence/plan.md"] }] });
    expect(yield* Effect.promise(() => reader.show(1))).toMatchObject({ commands: [
      "foundry ticket resume 1 --factory 'shop'", "foundry ticket retry 1 --factory 'shop'", "foundry ticket cancel 1 --factory 'shop'",
    ] });
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers: routedHandlers }).submit(owner, saved.rejection)))
      .toEqual(saved.result);
    expect(yield* snapshot(store)).toEqual(saved.after);
  })));
});

test("routed rejection ends its assignment and only later scheduling creates a fresh assignment", async () => {
  await fixture((store, firstId) => Effect.gen(function* () {
    // Non-code assessment isolates routing from the separately owned Git outcome guards.
    const submissions = createSubmissions({ store, handlers: routedHandlers });
    const scheduler = createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config: routedConfig }] });
    yield* Effect.promise(() => submissions.submit(owner, frame(firstId)));
    const assessment = (yield* scheduler.schedule())[0];

    if (assessment === undefined) {throw new Error("assessment not assigned");}

    const rejection = { ...frame(assessment.id), callId: "reject-1",
      args: { ...frame(assessment.id).args, outcome: "rejected", reason: "Revise plan" },
    };

    const before = yield* snapshot(store);
    const result = yield* Effect.promise(() => submissions.submit(owner, rejection));
    expect(result).toMatchObject({ status: "committed", value: { stage: "plan", status: "queued" } });
    const after = yield* snapshot(store);
    expect(after.tickets).toMatchObject([{ stage: "plan", status: "queued", rejections: 1 }]);
    expect(after.assignments).toHaveLength(2); // No inline assignment creation or continuation.
    expect(after.assignments.at(-1)).toMatchObject({ id: assessment.id, status: "ended", end_reason: "rejected" });
    expect(after.messages).toEqual(before.messages);
    expect(after.transitions).toHaveLength(before.transitions.length + 1);
    expect(after.transitions.at(-1)).toMatchObject({ actor: owner.slotId, from_stage: "assess", from_status: "assigned",
      to_stage: "plan", to_status: "queued", outcome: "rejected", reason: "Revise plan",
      git_commit: null, evidence: '["evidence/plan.md"]', config_load: "load-route" });
    expect(yield* Effect.promise(() => submissions.submit(owner, rejection))).toEqual(result);
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...rejection, callId: "stale-reject" })))
      .toMatchObject({ status: "refused", code: "not_assignment_owner" });
    expect(yield* snapshot(store)).toEqual(after);

    const returned = (yield* scheduler.schedule())[0];
    expect(returned).toMatchObject({ stage: "plan", slotId: owner.slotId });
    expect(returned?.id).not.toBe(firstId);
    expect(returned?.id).not.toBe(assessment.id);
    expect(yield* store.read(`SELECT status, end_reason FROM assignment WHERE id = ?`, [assessment.id]))
      .toEqual([{ status: "ended", end_reason: "rejected" }]);
  }));
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

test.each(["completed", "abandoned", "cancelled"])("done preserves the assignment until its whole delegation tree closes as %s", async (closedStatus) => {
  await fixture((store, id) => Effect.gen(function* () {
    const delegate = agentDelegateHandler(slots);
    yield* store.change((change) => delegate(change, {
      ...owner, callId: "delegate", tool: "agent_delegate", args: { recipient: "floor.worker", body: "Help with plan" },
    }));
    const [parent] = yield* store.read<{ id: string }>(`SELECT id FROM delegation WHERE root_assignment = ?`, [id]);

    if (parent === undefined) {throw new Error("fixture did not delegate");}

    const submissions = createSubmissions({ store, handlers });
    const before = yield* snapshot(store);
    expect(before.delegations).toHaveLength(1);
    expect(yield* Effect.promise(() => submissions.submit(owner, frame(id))))
      .toMatchObject({ status: "refused", code: "open_delegations" });
    expect(yield* snapshot(store)).toEqual(before);

    // Recipient selection and resolution have separate tickets. Seed their durable outcomes
    // here so this test exercises only delegation acceptance and the done boundary.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET recipient_slot = 'worker/2' WHERE id = ?`, [parent.id]);
      yield* delegate(change, { ...owner, slotId: "worker/2", callId: "child", tool: "agent_delegate",
        args: { recipient: "floor.worker", body: "Check the plan", parentDelegationId: parent.id } });
      yield* change.query(`UPDATE delegation SET status = 'completed' WHERE id = ?`, [parent.id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "parent-completed" });
    }));
    const descendantOpen = yield* snapshot(store);
    expect(descendantOpen.delegations).toMatchObject([
      { root_assignment: id, status: "completed" },
      { root_assignment: id, parent_id: parent.id, delegating_slot: "worker/2", status: "open" },
    ]);
    expect(yield* Effect.promise(() => submissions.submit(owner, frame(id))))
      .toMatchObject({ status: "refused", code: "open_delegations" });
    expect(yield* snapshot(store)).toEqual(descendantOpen);

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = ? WHERE parent_id = ?`, [closedStatus, parent.id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "child-closed" });
    }));
    const closed = yield* snapshot(store);
    // A refused call is not committed: the same call ID can succeed once obligations close.
    expect(yield* Effect.promise(() => submissions.submit(owner, frame(id))))
      .toMatchObject({ status: "committed", value: { assignmentId: id, stage: "implement", status: "queued" } });
    const after = yield* snapshot(store);
    expect(after.assignments).toMatchObject([{ id, status: "ended", end_reason: "done" }]);
    expect(after.tickets).toMatchObject([{ stage: "implement", status: "queued" }]);
    expect(after.transitions).toHaveLength(closed.transitions.length + 1);
    expect(after.submissions).toHaveLength(closed.submissions.length + 1);
    expect(after.delegations).toEqual(closed.delegations);
    expect(after.messages).toEqual(closed.messages);
  }));
});

test("another assignment's open delegation does not block done", async () => {
  await fixture((store, id, root) => Effect.gen(function* () {
    yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] })
      .submit({ title: "Other plan", spec: "Independent disposable spec" }).pipe(Effect.orDie);
    const [other] = yield* createAssignmentScheduler(schedulerOptions(store)).schedule();

    if (other === undefined) {throw new Error("fixture did not assign second ticket");}

    yield* store.change((change) => agentDelegateHandler(slots)(change, {
      ...owner, slotId: other.slotId, callId: "other-delegate", tool: "agent_delegate",
      args: { recipient: "floor.worker", body: "Help with other plan" },
    }));
    const before = yield* snapshot(store);
    expect(before.delegations).toMatchObject([{ root_assignment: other.id, status: "open" }]);
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
      .toMatchObject({ status: "committed" });
    const after = yield* snapshot(store);
    expect(after.assignments).toMatchObject([{ id, status: "ended" }, { id: other.id, status: "active" }]);
    expect(after.delegations).toEqual(before.delegations);
    expect(after.messages).toEqual(before.messages);
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
  { label: "gate without evaluated worktree", approval: true, writing: false, station: "floor.worker" },
  { label: "writing", approval: false, writing: true, station: "floor.worker" },
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
      .toMatchObject({ status: "refused", code: approval ? "commit_required" : "unsupported_transition" });
    expect(yield* snapshot(store)).toEqual(before);
  }));
});

test.each([
  { mode: "moved", writing: false, code: "non_writing_changes" },
  { mode: "mixed moved", writing: false, code: "non_writing_changes" },
  { mode: "mixed dirty", writing: false, code: "non_writing_changes" },
  { mode: "mixed wrong commit", writing: false, code: "invalid_code_outcome" },
  { mode: "mixed clean", writing: false, code: null },
  { mode: "planning baseline", writing: false, code: null },
  { mode: "race before transaction", writing: false, code: "invalid_code_outcome" },
  { mode: "race leading filename", writing: false, code: "invalid_code_outcome" },
  { mode: "race invalid UTF8", writing: false, code: "invalid_code_outcome" },
  { mode: "race discovery", writing: false, code: "invalid_code_outcome" },
  { mode: "race during writes", writing: false, code: "invalid_code_outcome" },
  { mode: "dirty", writing: false, code: "non_writing_changes" },
  { mode: "blocked dirty", writing: false, code: "non_writing_changes" },
  { mode: "rejected dirty", writing: false, code: "non_writing_changes" },
  { mode: "staged", writing: false, code: "non_writing_changes" },
  { mode: "assume-unchanged", writing: false, code: "non_writing_changes" },
  { mode: "skip-worktree", writing: false, code: "non_writing_changes" },
  { mode: "missing commit", writing: true, code: "commit_required" },
  { mode: "wrong commit", writing: true, code: "invalid_code_outcome" },
  { mode: "wrong branch", writing: false, code: "invalid_code_outcome" },
  { mode: "routed rejection clean", writing: false, code: null },
  { mode: "routed rejection moved", writing: false, code: "non_writing_changes" },
  { mode: "routed writing rejection", writing: true, code: null },
  { mode: "clean", writing: false, code: null },
  { mode: "untracked", writing: false, code: null },
  { mode: "new commit", writing: true, code: null },
])("real Git $mode (writing=$writing) preserves assignment on refusal", async ({ mode, writing, code }) => {
  await fixture((store, id, root) => Effect.gen(function* () {
    if (mode === "planning baseline") {
      expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
        .toMatchObject({ status: "committed" });
    }

    const repository = join(root, "repository");
    const path = join(root, "worktree");
    git(root, "init", "--quiet", "--initial-branch=main", repository);
    writeFileSync(join(repository, "tracked.txt"), "original\n");
    writeFileSync(join(repository, " leading.txt"), "original\n");

    if (mode === "race invalid UTF8") {writeFileSync(byteFilename(repository), "original\n");}

    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "base");
    const base = git(repository, "rev-parse", "HEAD");
    git(repository, "worktree", "add", "--quiet", "-b", "ticket/1", path);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'ticket/1', start_commit = ?`, [path, base]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "worktree" });
    }));

    const codeStage = { id: mode === "planning baseline" ? "implement" : "plan",
      station: mode.startsWith("mixed") || mode === "planning baseline" ? "floor.worker" : "floor.reviewer",
      approval: mode.startsWith("routed") && !writing, writing };

    const routedStage = mode.startsWith("routed") ? { ...codeStage, on_rejection: "revise" } : codeStage;

    const codeConfig = { ...config, production_lines: { standard: {
      ...config.production_lines.standard,
      stages: [
        ...(mode.startsWith("routed") ? [{ id: "revise", station: "floor.worker", approval: false, writing: false }] : []),
        routedStage,
        { id: "next", station: "floor.worker", approval: false, writing: false }],
    } } };

    const activeId = mode === "planning baseline"
      ? (yield* createAssignmentScheduler({ ...schedulerOptions(store), factories: [{ factoryId: "shop", config: codeConfig }] }).schedule())[0]?.id
      : id;

    if (activeId === undefined) {throw new Error("fixture did not assign code stage");}

    const codeHandlers = new Map([[TASK_TRANSITION, taskTransitionHandler({ factories: [{ factoryId: "shop", config: codeConfig }] })]]);

    if (["moved", "mixed moved", "mixed dirty", "new commit", "dirty", "blocked dirty", "rejected dirty", "staged", "routed rejection moved", "routed writing rejection"].includes(mode)) {
      writeFileSync(join(path, "tracked.txt"), "changed\n");

      if (!mode.endsWith("dirty")) {git(path, "add", ".");}

      if (mode.endsWith("moved") || mode === "new commit" || mode === "routed writing rejection") {git(path, "commit", "--quiet", "-m", "worker change");}
    }

    if (mode === "assume-unchanged" || mode === "skip-worktree") {
      git(path, "update-index", `--${mode}`, "--", "tracked.txt");
      writeFileSync(join(path, "tracked.txt"), "hidden change\n");
      expect(git(path, "status", "--porcelain=v1", "--untracked-files=no")).toBe("");
    }

    if (mode === "untracked") {writeFileSync(join(path, "notes.txt"), "not tracked\n");}

    if (mode === "wrong branch") {git(path, "checkout", "--quiet", "-b", "other");}

    const head = git(path, "rev-parse", "HEAD");
    const gitCommit = mode === "missing commit" ? {} : { gitCommit: mode.endsWith("wrong commit") ? "not-a-commit" : head };

    const reportedOutcome = mode.startsWith("routed") ? "rejected" : Match.value(mode).pipe(
      Match.when("blocked dirty", () => "blocked" as const),
      Match.when("rejected dirty", () => "rejected" as const),
      Match.orElse(() => "done" as const),
    );

    const outcome = { ...frame(activeId), callId: "code-done", args: { assignmentId: activeId, outcome: reportedOutcome, reason: "Code evaluated", evidence: ["evidence/tests.md"], ...gitCommit } } as const;
    const before = yield* snapshot(store);

    const submissionStore: Store = mode.startsWith("race") ? { ...store, change: (body) => store.change((change) => Effect.gen(function* () {
      if (mode === "race before transaction") {writeFileSync(join(path, "tracked.txt"), "raced\n");}

      if (mode === "race leading filename") {writeFileSync(join(path, " leading.txt"), "raced\n");}

      if (mode === "race invalid UTF8") {writeFileSync(byteFilename(path), "raced\n");}

      return yield* body({ ...change, query: (sql, params) => {
        if (mode === "race during writes" && sql.startsWith("UPDATE assignment")) {writeFileSync(join(path, "tracked.txt"), "raced\n");}

        return change.query(sql, params);
      } });
    })) } : store;

    const submissions = createSubmissions({ store: submissionStore, handlers: codeHandlers });
    const cloneGit = yield* Effect.promise(() => import("../dist/factory-clone.js"));
    const originalGit = cloneGit.runCloneGit;

    const discoveryRace = mode === "race discovery" ? vi.spyOn(cloneGit, "runCloneGit").mockImplementation(async (args, env, cwd, raw) => {
      if (!args.includes("ls-files")) {return originalGit(args, env, cwd, raw);}

      // Restore identical index contents after discovery omits a tracked file. The acceptance
      // fence must detect index replacement, not merely compare the restored content hash.
      git(path, "rm", "--cached", "--", "tracked.txt");
      const output = await originalGit(args, env, cwd, raw);
      git(path, "reset", "--quiet", "HEAD", "--", "tracked.txt");

      return output;
    }) : undefined;

    const result = yield* Effect.promise(() => submissions.submit(owner, outcome).finally(() => discoveryRace?.mockRestore()));

    if (code !== null) {
      expect(result).toMatchObject({ status: "refused", code });
      expect(yield* snapshot(store)).toEqual(before);
    } else {
      expect(result).toMatchObject({ status: "committed", value: { stage: mode.startsWith("routed") ? "revise" : "next", status: "queued" } });
      const after = yield* snapshot(store);
      expect(after.assignments).toContainEqual(expect.objectContaining({ id: activeId, status: "ended", end_reason: reportedOutcome }));
      expect(after.transitions.at(-1)).toMatchObject({ git_commit: head, outcome: reportedOutcome });
      // Even if the worktree disappears, a retry returns the durable result.
      git(repository, "worktree", "remove", "--force", path);
      expect(yield* Effect.promise(() => submissions.submit(owner, outcome))).toEqual(result);
      expect(yield* snapshot(store)).toEqual(after);
    }
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
      actor: "worker/1", reason: "Need operator input", git_commit: null,
      evidence: '["evidence/plan.md"]', config_load: "load-1" });
    expect(after.approvals).toMatchObject([{ kind: "blocked", state: "open", assignment_id: id }]);
    const blocked = yield* store.read<{ id: number }>(`SELECT id FROM approval WHERE kind = 'blocked'`);
    const approvalId = blocked[0]?.id;

    if (approvalId === undefined) {throw new Error("missing blocked approval");}

    expect(yield* Effect.flip(createApprovalAnswers(store, slots).answer(approvalId, "Not allowed")))
      .toMatchObject({ code: "wrong_kind" });
    expect(yield* snapshot(store)).toEqual(after);
    expect(after.history.slice(before.history.length)).toMatchObject([
      { kind: "ticket.transitioned" }, { kind: "approval.requested" }, { kind: "submission.recorded" },
    ]);
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

test("blocked works at final and code stages without requiring a destination; routed code rejection stays guarded", async () => {
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
          .toMatchObject({ status: "refused", code: "invalid_code_outcome" });
        expect(yield* snapshot(store)).toEqual(before);
      }

      expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, outcome: "blocked" } })))
        .toMatchObject({ status: "committed", value: { stage, status: "paused" } });
    }));
  }
});

test("unroutable rejection at the final stage pauses rather than requiring a next stage", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET stage = 'final', rejections = 2, rejection_ceiling = 3`);
      yield* change.query(`UPDATE assignment SET stage = 'final'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "final" });
    }));

    const finalConfig = { ...config, production_lines: { standard: {
      ...config.production_lines.standard,
      stages: [{ id: "final", station: "floor.worker", approval: true, writing: false }],
    } } };

    const finalHandlers = new Map([[TASK_TRANSITION, taskTransitionHandler({ factories: [{ factoryId: "shop", config: finalConfig }] })]]);
    expect(yield* Effect.promise(() => createSubmissions({ store, handlers: finalHandlers }).submit(owner,
      { ...frame(id), args: { ...frame(id).args, outcome: "rejected" } })))
      .toMatchObject({ status: "committed", value: { stage: "final", status: "paused" } });
    expect(yield* store.read(`SELECT rejections FROM ticket`)).toEqual([{ rejections: 2 }]);
    expect((yield* Effect.promise(() => storeApprovalsReader(store).list())).approvals)
      .toMatchObject([{ kind: "blocked", stage: "final", outcome: "rejected" }]);
  }));
});

test("stage-gate migration preserves populated blocked and worker-request approvals and refuses wrong-kind decisions", async () => {
  const previous: ReadonlyArray<Migration> = foundryMigrations.slice(0, foundryMigrations.findIndex((migration) => migration.name === "stage_gate_approvals"));

  const saved = await fixture((store, id, root) => Effect.gen(function* () {
    const submissions = createSubmissions({ store, handlers: new Map([...handlers, [HUMAN_REQUEST, humanRequestHandler]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { type: "tool_call", tool: HUMAN_REQUEST, callId: "request",
      args: { assignmentId: id, body: "Choose option" } })))
      .toMatchObject({ status: "committed" });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, outcome: "blocked" } })))
      .toMatchObject({ status: "committed" });

    return { root, approvals: yield* store.read(`SELECT * FROM approval`), state: yield* snapshot(store) };
  }), previous);

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    const before = yield* snapshot(store);
    expect(before).toEqual({ ...saved.state,
      approvals: saved.approvals.map((approval) => ({ ...approval, decision: null, resolution_transition: null })),
    });
    const decisions = createApprovalDecisions({ store, factories: [{ factoryId: "shop", config }] });

    for (const id of [1, 2]) {
      for (const decision of ["approved", "rejected"] as const) {
        const exit = yield* Effect.exit(decisions.resolve(id, decision, "Wrong kind"));
        expect(exit).toMatchObject(Exit.fail({ code: "invalid_state" }));
      }
    }

    expect(yield* snapshot(store)).toEqual(before);
    expect((yield* Effect.promise(() => storeApprovalsReader(store).list())).approvals).toMatchObject([
      { id: 1, kind: "worker_request", reason: "Choose option" }, { id: 2, kind: "blocked", reason: "Plan ready" },
    ]);
  })));
});

// One real SQLite/socket boundary proves operator-only resolution and exact commit provenance.
const gateFixture = <A, E>(final: boolean, routed: boolean,
  use: (store: Store, id: string, root: string, head: string, gatedConfig: typeof config) => Effect.Effect<A, E>,
  migrations?: ReadonlyArray<Migration>) =>
  fixture((store, id, root) => Effect.gen(function* () {
    const repository = join(root, "repository");
    git(root, "init", "--quiet", "--initial-branch=main", repository);
    writeFileSync(join(repository, "tracked.txt"), "base\n");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "base");
    const path = join(root, "worktree");
    git(repository, "worktree", "add", "--quiet", "-b", "ticket/1", path);
    const head = git(path, "rev-parse", "HEAD");

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'ticket/1', start_commit = ?`, [path, head]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "worktree" });
    }));
    const stage = { id: "plan", station: "floor.reviewer", approval: true, writing: false };

    const gatedConfig = { ...config, production_lines: { standard: { ...config.production_lines.standard, stages: [
      ...(routed ? [{ id: "revise", station: "floor.worker", approval: false, writing: false }] : []),
      routed ? { ...stage, on_rejection: "revise" } : stage,
      ...(final ? [] : [{ id: "next", station: "floor.worker", approval: false, writing: false }]),
    ] } } };

    return yield* use(store, id, root, head, gatedConfig);
  }), migrations);

test("final approval wakes the durable integration queue after commit", async () => {
  await gateFixture(true, true, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } })))
      .toMatchObject({ status: "committed" });

    const queue = createFactorySyncer({ store, env: isolatedGitEnv(),
      target: () => ({ clonePath: join(root, "repository"), defaultBranch: "main" }) });

    let drain = Promise.resolve();

    const decisions = createApprovalDecisions({ store, factories,
      onIntegrationQueued: () => { drain = queue.resumeQueued("shop"); } });

    yield* decisions.resolve(1, "approved");
    yield* Effect.promise(() => drain);

    expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "complete", result: { head } }]);
    expect(yield* store.read(`SELECT state FROM ticket`)).toEqual([{ state: "completed" }]);
  }));
});

// Reuse the gate fixture: this boundary test includes worker outcome, operator approval,
// durable queue reopen and real Git; no daemon, HTTP or production state is needed.
test.each(["complete", "merge", "cleanup-dirty", "cleanup-hook-failed", "moved", "conflict", "conflict-limit", "dirty", "cancelled", "merge-error", "stale"] as const)("approved integration: %s", async (scenario) => {
  const saved = await gateFixture(true, true, (store, id, root, base, gatedConfig) => Effect.gen(function* () {
    const repository = join(root, "repository");
    const path = join(root, "worktree");
    const source = join(root, "source.git");

    if (scenario === "merge") {
      // Default A—B stays at the recorded start B; writing rebased the ticket to A—C.
      writeFileSync(join(repository, "default-base.txt"), "preserve default\n");
      git(repository, "add", ".");
      git(repository, "commit", "--quiet", "-m", "default base B");
      const start = git(repository, "rev-parse", "HEAD");
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET start_commit = ?`, [start]);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "rebased before review" });
      }));
    }

    git(root, "clone", "--quiet", "--bare", repository, source);
    git(repository, "remote", "add", "origin", source);
    const sourceRefs = git(source, "for-each-ref", "--format=%(refname) %(objectname)");
    writeFileSync(join(path, "reviewed.txt"), "reviewed\n");
    git(path, "add", ".");
    git(path, "commit", "--quiet", "-m", "reviewed");
    const approved = git(path, "rev-parse", "HEAD");
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
        from_state, from_stage, to_state, to_stage, to_status, git_commit)
        VALUES ('shop', 1, 1, 'fixture-writer', 'stage', 'revise', 'stage', 'plan', 'assigned', ?)`, [approved]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "writing complete" });
    }));
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: approved } })))
      .toMatchObject({ status: "committed" });
    yield* createApprovalDecisions({ store, factories }).resolve(1, "approved");
    expect(yield* listOperations(store, "shop")).toMatchObject([{ kind: "integration", status: "queued", intent: { approvedCommit: approved } }]);
    expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "stage", status: "awaiting_approval" }]);

    // Exact-SHA integration cannot consume an approval invalidated by a later HEAD.
    if (scenario === "stale") {
      writeFileSync(join(path, "later.txt"), "not reviewed\n");
      git(path, "add", ".");
      git(path, "commit", "--quiet", "-m", "later");
    }

    const branchHead = git(path, "rev-parse", "HEAD");

    if (scenario === "conflict-limit") {
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET rejections = rejection_ceiling - 1`);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "near limit" });
      }));
    }

    if (scenario === "moved" || scenario === "conflict" || scenario === "conflict-limit") {
      writeFileSync(join(repository, scenario === "moved" ? "default.txt" : "reviewed.txt"), "concurrent\n");
      git(repository, "add", ".");
      git(repository, "commit", "--quiet", "-m", "default advanced");
    } else if (scenario === "dirty") {
      writeFileSync(join(repository, "untracked.txt"), "preserve me\n");
    } else if (scenario === "cancelled") {
      const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(gatedConfig)] });
      const inspection = yield* service.inspectCancellation("shop", 1);
      yield* service.cancel("shop", 1, inspection.confirmation);
    }

    if (scenario === "cleanup-dirty") {writeFileSync(join(path, "untracked.txt"), "preserve ticket work\n");}

    const yamlFile = join(root, "factory.yaml");
    writeFileSync(yamlFile, JSON.stringify({ version: 1, name: "shop",
      repository: { source: repository, default_branch: "main" }, default_production_line: "standard",
      rooms: { floor: { stations: { worker: { isolation: "worktree", model: "fake/model" } } } },
      production_lines: { standard: { stages: [
        { id: "revise", station: "floor.worker", writing: true },
        { id: "plan", station: "floor.worker", approval: true, on_rejection: "revise" },
      ] } },
      worktrees: { before_remove: scenario === "cleanup-hook-failed" ? ["sh", "-c", "exit 19"] : undefined },
    }));

    return { root, repository, path, source, sourceRefs, base, approved, branchHead, yamlFile, gatedConfig, previousHead: git(repository, "rev-parse", "main") };
  }));

  // Reopen before consuming: approved integration is not an in-memory callback.
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    const env = isolatedGitEnv();

    // The daemon must not depend on an operator's configured identity.
    for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
      delete env[key];
    }

    let queueError = "";

    if (scenario === "merge-error") {
      // Real Git updates the ref successfully; its wrapper then loses the success result.
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const bin = join(saved.root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "git"), `#!/bin/sh
"$FOUNDRY_REAL_GIT" "$@"
status=$?
for arg do
  if [ "$arg" = merge ]; then exit 73; fi
done
exit "$status"
`, { mode: 0o755 });
      env["FOUNDRY_REAL_GIT"] = realGit;
      env["PATH"] = `${bin}:${process.env["PATH"]}`;
    }

    const loaded = loadFactoryFiles([saved.yamlFile], { env: {} });

    if (LoadFactoriesResult.$is("Refused")(loaded)) {throw new Error(loaded.message);}

    const factory = loaded.factories[0];

    if (factory === undefined) {throw new Error("fixture factory missing");}

    const worktrees = createWorktreeService({ store, stateRoot: saved.root, env, factories: () => ["shop"],
      target: () => ({ factory, clonePath: saved.repository }) });

    const queue = createFactorySyncer({ store, env, worktrees, target: () => ({ clonePath: saved.repository, defaultBranch: "main", config: saved.gatedConfig }),
      onError: (_factory, cause) => { queueError = String(cause); } });

    yield* Effect.promise(() => queue.resumeQueued("shop"));

    if (scenario === "merge-error") {
      expect(queueError).not.toBe("");
      expect(git(saved.repository, "rev-parse", "main")).toBe(saved.approved);
      expect(git(saved.path, "rev-parse", "HEAD")).toBe(saved.branchHead);
      expect(git(saved.source, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(saved.sourceRefs);
      expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "running", result: null }]);
      expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "stage", status: "awaiting_approval" }]);
      yield* enqueueOperation(store, { factoryId: "shop", kind: "sync", intent: { defaultBranch: "main" } });
      expect(yield* startNextOperation(store, "shop")).toBeUndefined();
      const service = createTicketService({ store, stateRoot: saved.root, factories: () => [ticketFactoryFrom(config)] });
      expect(yield* Effect.exit(service.inspectCancellation("shop", 1))).toMatchObject(Exit.fail({ code: "invalid_state" }));

      return;
    }

    const removed = scenario === "complete" || scenario === "merge";
    const complete = removed || scenario === "cleanup-dirty" || scenario === "cleanup-hook-failed";
    const landed = git(saved.repository, "rev-parse", "main");
    const operations = yield* listOperations(store, "shop");
    expect(operations).toMatchObject([{ kind: "integration", status: complete ? "complete" : "failed",
      result: complete ? { head: landed, fastForward: scenario !== "merge", cleanup: "pending" } : { reason: expect.any(String) } },
    ...(complete ? [{ kind: "cleanup", status: removed ? "complete" : "failed" }] : []),
    ...(scenario === "cleanup-hook-failed" ? [{ kind: "hook", status: "failed" }] : [])]);
    expect(yield* store.read(`SELECT state, status, worktree_path, branch FROM ticket`)).toEqual([{
      state: complete ? "completed" : scenario === "cancelled" ? "cancelled" : "stage",
      status: complete || scenario === "cancelled" ? null : scenario === "conflict" ? "queued" : "paused", worktree_path: removed ? null : saved.path, branch: removed ? null : "ticket/1",
    }]);

    if (!complete) {expect(landed).toBe(saved.previousHead);}

    const service = createTicketService({ store, stateRoot: saved.root, factories: () => [ticketFactoryFrom(saved.gatedConfig)] });
    const detail = yield* service.show("shop", 1);
    expect(detail.transitions.at(-1)?.evidence).toEqual(scenario === "conflict" || scenario === "conflict-limit" ? ["reviewed.txt"] : []);

    if (scenario === "conflict" || scenario === "conflict-limit") {
      expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "failed", result: {
        previousHead: saved.previousHead, approvedCommit: saved.approved, conflictingFiles: ["reviewed.txt"], reason: "Merge conflict in: reviewed.txt",
      } }]);
      expect(yield* store.read(`SELECT stage, rejections, rejection_ceiling FROM ticket`)).toMatchObject([{
        stage: "revise", rejections: scenario === "conflict" ? 1 : 3,
      }]);
      expect(yield* store.read(`SELECT outcome, reason FROM ticket_transition ORDER BY sequence DESC LIMIT 1`))
        .toEqual([{ outcome: "rejected", reason: "Merge conflict in: reviewed.txt" }]);
      expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual([]);
      expect(git(saved.repository, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
      expect(git(saved.repository, "status", "--porcelain")).toBe("");

      if (scenario === "conflict-limit") {
        const reader = storeApprovalsReader(store);
        const listed = yield* Effect.promise(() => reader.list());
        expect(listed.approvals).toMatchObject([{ kind: "limit_reached", state: "open", evidence: ["reviewed.txt"] }]);
        const approval = expectDefined(listed.approvals[0], "limit approval");
        expect(yield* Effect.promise(() => reader.show(approval.id))).toMatchObject({ approval: { evidence: ["reviewed.txt"] } });
      }
    }

    expect(existsSync(saved.path)).toBe(!removed);

    if (removed) {
      expect(git(saved.repository, "branch", "--list", "ticket/1")).toBe("");
      expect(git(saved.repository, "worktree", "list", "--porcelain")).not.toContain(saved.path);
    } else {expect(git(saved.path, "rev-parse", "HEAD")).toBe(saved.branchHead);}

    if (scenario === "cleanup-dirty") {expect(readFileSync(join(saved.path, "untracked.txt"), "utf8")).toBe("preserve ticket work\n");}

    expect(git(saved.source, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(saved.sourceRefs);

    if (complete) {
      if (scenario === "merge") {
        expect(git(saved.repository, "rev-list", "--parents", "-n", "1", "main").split(" "))
          .toEqual([landed, saved.previousHead, saved.approved]);
        expect(git(saved.repository, "show", "main:default-base.txt")).toBe("preserve default");
      } else {
        expect(landed).toBe(saved.approved);
      }

      expect(git(saved.repository, "merge-base", "--is-ancestor", saved.approved, "main")).toBe("");
      expect(git(saved.repository, "show", "main:reviewed.txt")).toBe("reviewed");
      expect(yield* store.read(`SELECT git_commit, to_state FROM ticket_transition ORDER BY sequence DESC LIMIT 1`))
        .toEqual([{ git_commit: saved.approved, to_state: "completed" }]);
      yield* Effect.promise(() => queue.resumeQueued("shop"));
      expect(yield* listOperations(store, "shop")).toEqual(operations);
      expect(queueError).toBe("");
    } else if (scenario === "dirty") {
      expect(readFileSync(join(saved.repository, "untracked.txt"), "utf8")).toBe("preserve me\n");
    }

    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);
  })));
});

test("head movement after integration reads its intent cannot land or overwrite the voided stage", async () => {
  await gateFixture(true, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } }));
    yield* createApprovalDecisions({ store, factories }).resolve(1, "approved");
    let moved = false;
    const path = join(root, "worktree");

    const racing: Store = { ...store, read: <Row extends object>(statement: string, params?: ReadonlyArray<SqlValue>) => Effect.gen(function* () {
      const rows = yield* store.read<Row>(statement, params);

      if (!moved && statement.includes("t.start_commit, t.branch, i.approved_commit")) {
        moved = true;
        writeFileSync(join(path, "tracked.txt"), "not reviewed\n");
        git(path, "commit", "-am", "not reviewed", "--quiet");
        // Invalidation cannot race ref mutation under the integration consumer's permit.
        expect(Exit.isFailure(yield* Effect.exit(voidStaleApprovals({ store: racing, factories })))).toBe(true);
      }

      return rows;
    }) };

    const queue = createFactorySyncer({ store: racing, env: isolatedGitEnv(),
      target: () => ({ clonePath: join(root, "repository"), defaultBranch: "main" }) });

    yield* Effect.promise(() => queue.resumeQueued("shop"));
    expect(moved).toBe(true);
    expect(git(join(root, "repository"), "rev-parse", "main")).toBe(head);
    expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "failed", result: { reason: expect.stringContaining("head changed") } }]);
    expect(yield* voidStaleApprovals({ store: racing, factories })).toBe(1);
    expect(yield* store.read(`SELECT state, stage, status FROM ticket`)).toEqual([{ state: "stage", stage: "plan", status: "queued" }]);
    yield* Effect.promise(() => queue.resumeQueued("shop"));
    expect(yield* store.read(`SELECT state, stage, status FROM ticket`)).toEqual([{ state: "stage", stage: "plan", status: "queued" }]);
  }));
});

test.each([false, true])("integration fences ticket HEAD and never removes a pre-existing lock (existing=%s)", async (existing) => {
  await gateFixture(true, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } }));
    yield* createApprovalDecisions({ store, factories }).resolve(1, "approved");
    const repository = join(root, "repository");
    const tree = git(repository, "rev-parse", `${head}^{tree}`);
    const unreviewed = git(repository, "commit-tree", tree, "-p", head, "-m", "unreviewed");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
for arg do
  if [ "$arg" = merge ]; then
    if "$FOUNDRY_REAL_GIT" -C "$FOUNDRY_CLONE" update-ref refs/heads/ticket/1 "$FOUNDRY_UNREVIEWED" 2>/dev/null; then
      exit 99
    fi
    printf blocked > "$FOUNDRY_REF_ATTEMPT"
  fi
done
exec "$FOUNDRY_REAL_GIT" "$@"
`, { mode: 0o755 });
    const attempt = join(root, "attempt");

    const env = { ...isolatedGitEnv(), FOUNDRY_REAL_GIT: realGit, FOUNDRY_CLONE: repository,
      FOUNDRY_UNREVIEWED: unreviewed, FOUNDRY_REF_ATTEMPT: attempt, PATH: `${bin}:${process.env["PATH"]}` };

    const lockPath = join(repository, ".git", "refs", "heads", "ticket", "1.lock");

    if (existing) {writeFileSync(lockPath, "external owner");}

    const queue = createFactorySyncer({ store, env, target: () => ({ clonePath: repository, defaultBranch: "main" }) });
    yield* Effect.promise(() => queue.resumeQueued("shop"));

    if (existing) {
      expect(readFileSync(lockPath, "utf8")).toBe("external owner");
      expect(existsSync(attempt)).toBe(false);
      expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "stage", status: "paused" }]);

      return;
    }

    expect(readFileSync(attempt, "utf8")).toBe("blocked");
    expect(git(repository, "rev-parse", "ticket/1")).toBe(head);
    expect(yield* store.read(`SELECT state FROM ticket`)).toEqual([{ state: "completed" }]);
    expect(existsSync(lockPath)).toBe(false);
  }));
});

test("cancel resolves a stage gate to its cancellation transition without approving or rejecting the commit", async () => {
  await gateFixture(false, true, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } })))
      .toMatchObject({ status: "committed" });
    const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(gatedConfig)] });
    const inspection = yield* service.inspectCancellation("shop", 1);
    const result = yield* service.cancel("shop", 1, inspection.confirmation);
    expect(result.ticket).toMatchObject({ state: "cancelled", worktree: { startCommit: head } });
    const resolved = yield* Effect.promise(() => storeApprovalsReader(store).show(1));
    expect(resolved).toMatchObject({ approval: { kind: "stage_gate", state: "resolved", decision: null,
      resolutionTransition: expect.any(Number) }, commands: [] });
    expect(yield* store.read(`SELECT t.to_state FROM approval a JOIN ticket_transition t ON t.sequence = a.resolution_transition WHERE a.id = 1`))
      .toEqual([{ to_state: "cancelled" }]);
    expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual([]);
    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);
    expect(yield* createAssignmentScheduler({ store, slots, factories }).schedule()).toEqual([]);
  }));
});

test("cancellation migration preserves resolved stage gates and integration-intent foreign keys", async () => {
  const saved = await gateFixture(true, true, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } }));
    // Populate the pre-voiding schema as the old resolver did; this tests migration,
    // not current runtime services against an intentionally outdated database.
    yield* store.change((change) => Effect.gen(function* () {
      const [transition] = yield* change.query<{ sequence: number }>(`INSERT INTO ticket_transition
        (factory_id, ticket_number, recorded_at, actor, from_state, from_stage, from_status, to_state, to_stage, to_status, outcome, git_commit)
        VALUES ('shop', 1, 1, 'operator', 'stage', 'plan', 'awaiting_approval', 'stage', 'plan', 'awaiting_approval', 'done', ?) RETURNING sequence`, [head]);

      if (transition === undefined) {throw new Error("missing fixture transition");}

      yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = 1, decision = 'approved', resolution_transition = ?`, [transition.sequence]);
      yield* change.query(`INSERT INTO integration_intent VALUES (1, 'shop', 1, ?, ?, 1)`, [head, transition.sequence]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "old-approved-gate" });
    }));

    return { root, approvals: yield* store.read(`SELECT * FROM approval`), intents: yield* store.read(`SELECT * FROM integration_intent`) };
  }), foundryMigrations.filter((migration) => migration.id < 26));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* store.read(`SELECT * FROM approval`)).toEqual(saved.approvals);
    expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual(saved.intents);
    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);
  })));
});

test.each([
  { final: false, decision: "approve", routed: true },
  { final: true, decision: "approve", routed: true },
  { final: false, decision: "reject", routed: true },
  { final: true, decision: "reject", routed: true },
  { final: false, decision: "reject", routed: false },
] as const)("gate $decision (final=$final routed=$routed) is operator-only and bound to evaluated commit", async ({ final, decision, routed }) => {
  const saved = await gateFixture(final, routed, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const gateHandlers = new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })], [HUMAN_REQUEST, humanRequestHandler]]);
    const submissions = createSubmissions({ store, handlers: gateHandlers });
    const done = { ...frame(id), args: { ...frame(id).args, gitCommit: head } };
    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    expect(yield* Effect.promise(() => createSubmissions({ store: failing, handlers: gateHandlers }).submit(owner, done)))
      .toMatchObject({ status: "refused", code: "not_committed" });
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* Effect.promise(() => submissions.submit(owner, done)))
      .toMatchObject({ status: "committed", value: { approvalId: 1, stage: "plan", status: "awaiting_approval" } });
    const opened = yield* snapshot(store);
    expect(opened.assignments).toMatchObject([{ id, status: "ended", end_reason: "done" }]);
    expect(opened.tickets).toMatchObject([{ stage: "plan", status: "awaiting_approval" }]);
    expect(opened.approvals).toMatchObject([{ kind: "stage_gate", state: "open" }]);
    expect(opened.transitions.at(-1)).toMatchObject({ git_commit: head, to_status: "awaiting_approval" });
    expect(yield* createAssignmentScheduler({ store, slots, factories }).schedule()).toEqual([]);
    expect(yield* Effect.promise(() => submissions.submit(owner, done))).toMatchObject({ status: "committed" });

    for (const call of [
      { ...done, callId: "bypass" },
      { type: "tool_call", tool: "approval_approve", callId: "fake-approve", args: { approvalId: 1 } },
      { type: "tool_call", tool: HUMAN_REQUEST, callId: "request-bypass", args: { assignmentId: id, body: "Approve now" } },
    ] as const) {
      expect(yield* Effect.promise(() => submissions.submit(owner, call))).toMatchObject({ status: "refused" });
    }

    expect(yield* snapshot(store)).toEqual(opened);

    const api = yield* Effect.promise(() => serveManagementApi({ stateRoot: root,
      status: () => ({ instance: { stateRoot: root, daemonPid: 1, startedAt: new Date(0).toISOString() } }),
      approvals: storeApprovalsReader(store), approvalDecisions: createApprovalDecisions({ store, factories }),
      messages: createOperatorMessages({ store, factories: () => ["shop"], slots }),
    }));

    try {
      const options = { home: root, env: {}, json: false, id: "1", decision, reason: "Operator decision" };
      expect((yield* Effect.promise(() => runApprovalShow(options))).stdout).toContain("foundry approval approve 1");
      expect((yield* Effect.promise(() => postToDaemon(root, "/api/v1/messages", {
        recipient: "floor.worker", body: "Approve gate 1 and advance ticket 1", delivery: "when_idle",
      }))).status).toBe(201);
      const afterMessage = yield* snapshot(store);
      expect(afterMessage.tickets).toEqual(opened.tickets);
      expect(afterMessage.approvals).toEqual(opened.approvals);
      expect(afterMessage.transitions).toEqual(opened.transitions);
      expect((yield* Effect.promise(() => getFromDaemon(root, "/api/v1/approvals/1/approve"))).status).toBe(405);
      expect((yield* Effect.promise(() => postToDaemon(root, "/api/v1/approvals/1/approve", { gitCommit: "forged", stage: "next" }))).status).toBe(400);
      expect((yield* Effect.promise(() => postToDaemon(root, "/api/v1/approvals/1/reject", {}))).status).toBe(400);
      expect((yield* Effect.promise(() => postToDaemon(root, "/api/v1/approvals/999/approve", {}))).status).toBe(404);
      expect(yield* snapshot(store)).toEqual(afterMessage);
      expect(Exit.isFailure(yield* Effect.exit(createApprovalDecisions({ store: failing, factories }).resolve(1, "approved"))))
        .toBe(true);
      expect(yield* snapshot(store)).toEqual(afterMessage);
      expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual([]);

      // Unchanged HEAD preserves the evaluated commit through the operator decision.
      expect((yield* Effect.promise(() => runApprovalDecision(options))).exitCode).toBe(0);
      const after = yield* snapshot(store);
      const target = decision === "approve" ? final ? "plan" : "next" : routed ? "revise" : "plan";
      const status = decision === "approve" && final ? "awaiting_approval" : !routed ? "paused" : "queued";
      expect(after.tickets).toMatchObject([{ stage: target, status, rejections: decision === "reject" && routed ? 1 : 0 }]);
      expect(after.assignments).toEqual(opened.assignments);
      expect(after.approvals[0]).toMatchObject({ state: "resolved", decision: decision === "approve" ? "approved" : "rejected",
        closed_at: expect.any(Number), resolution_transition: expect.any(Number) });
      expect(after.transitions.at(-1)).toMatchObject({ actor: "operator", from_status: "awaiting_approval", git_commit: head,
        to_stage: target, to_status: status, reason: "Operator decision" });
      const intents = yield* store.read(`SELECT * FROM integration_intent`);

      if (decision === "approve" && final) {
        expect(intents).toMatchObject([{ approval_id: 1, approved_commit: head, factory_id: "shop", ticket_number: 1 }]);
        expect(after.history).toContainEqual(expect.objectContaining({ kind: "integration.requested" }));
      } else {expect(intents).toEqual([]);}

      if (decision === "reject" && !routed) {
        expect(after.approvals).toHaveLength(2);
        expect(after.approvals[1]).toMatchObject({ kind: "blocked", state: "open" });
      }

      expect((yield* Effect.promise(() => runApprovalShow(options))).stdout).not.toContain("foundry approval approve");
      expect((yield* Effect.promise(() => runApprovalDecision(options))).exitCode).not.toBe(0);
      expect(yield* snapshot(store)).toEqual(after);

      return { root, after, intents };
    } finally {yield* Effect.promise(() => api.close());}
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
    expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual(saved.intents);
  })));
});

test("operator routed rejection respects the persisted rejection ceiling after a gate", async () => {
  await gateFixture(false, true, (store, id, _root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET rejections = 2, rejection_ceiling = 3`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "near-ceiling" });
    }));
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } })))
      .toMatchObject({ status: "committed", value: { status: "awaiting_approval" } });
    const opened = yield* snapshot(store);
    expect(opened.approvals).toMatchObject([{ kind: "stage_gate", state: "open" }]);
    const decisions = createApprovalDecisions({ store, factories });
    expect(yield* decisions.resolve(1, "rejected", "Another revision"))
      .toMatchObject({ decision: "rejected", commit: head, integrationRequested: false });
    const after = yield* snapshot(store);
    expect(after.tickets).toMatchObject([{ stage: "revise", status: "paused", rejections: 3, rejection_ceiling: 3 }]);
    expect(after.assignments).toEqual(opened.assignments);
    expect(after.approvals).toMatchObject([{ kind: "stage_gate", state: "resolved" }, { kind: "limit_reached", state: "open" }]);
    expect(after.transitions.at(-1)).toMatchObject({ actor: "operator", outcome: "rejected", to_stage: "revise", to_status: "paused", git_commit: head });
    expect(yield* createAssignmentScheduler({ store, slots, factories }).schedule()).toEqual([]);
    expect(yield* Effect.exit(decisions.resolve(1, "rejected", "Repeat"))).toMatchObject(Exit.fail({ code: "invalid_state" }));
    expect(yield* snapshot(store)).toEqual(after);
  }));
});

test.each([false, true])("changed head voids an %s-approved final gate, preserves history and survives restart", async (approved) => {
  const saved = await gateFixture(true, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } }));

    if (approved) {yield* createApprovalDecisions({ store, factories }).resolve(1, "approved");}

    const invalidated = yield* store.read<{ sequence: number }>(`SELECT sequence FROM ticket_transition WHERE outcome = 'done' ORDER BY sequence`);
    const before = yield* snapshot(store);
    expect(yield* voidStaleApprovals({ store, factories })).toBe(0);
    expect(yield* snapshot(store)).toEqual(before);
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "new head\n");
    git(path, "commit", "-am", "new head", "--quiet");
    const current = git(path, "rev-parse", "HEAD");
    expect(yield* voidStaleApprovals({ store, factories, configLoad: () => "void-load" })).toBe(1);
    const after = yield* snapshot(store);
    expect(after.tickets).toMatchObject([{ stage: "plan", status: "queued" }]);
    expect(after.transitions.slice(0, -1)).toEqual(before.transitions);
    expect(after.transitions.at(-1)).toMatchObject({ actor: "daemon", outcome: "voided", to_stage: "plan", to_status: "queued",
      git_commit: current, voided_transitions: JSON.stringify(invalidated.map((row) => row.sequence)), config_load: "void-load" });
    expect(after.approvals).toMatchObject([{ state: "resolved", decision: approved ? "approved" : null }]);
    expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual([]);
    expect(yield* Effect.promise(() => storeApprovalsReader(store).list())).toEqual({ approvals: [] });
    expect(Exit.isFailure(yield* Effect.exit(createApprovalDecisions({ store, factories }).resolve(1, "approved")))).toBe(true);
    expect(yield* voidStaleApprovals({ store, factories })).toBe(0);
    expect(yield* snapshot(store)).toEqual(after);
    const detail = yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(gatedConfig)] }).show("shop", 1);
    expect(detail.transitions.at(-1)?.voidedTransitions).toEqual(invalidated.map((row) => row.sequence));
    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);

    return { root, after };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* snapshot(store)).toEqual(saved.after);
  })));
});

test("operator gates on writing stages are commit-bound too", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const writingConfig = { ...gatedConfig, production_lines: { standard: { stages:
      (gatedConfig.production_lines.standard?.stages ?? []).map((stage) => ({ ...stage, writing: stage.id === "plan" })),
    } } };

    const factories = [{ factoryId: "shop", config: writingConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    expect(yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } })))
      .toMatchObject({ status: "committed", value: { status: "awaiting_approval" } });
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "moved\n");
    git(path, "commit", "-am", "moved", "--quiet");
    expect(yield* voidStaleApprovals({ store, factories })).toBe(1);
    expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: "plan", status: "queued" }]);
  }));
});

test("operator decision itself detects a stale gate, without waiting for a background sweep", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } }));
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "moved\n");
    git(path, "commit", "-am", "moved", "--quiet");
    expect(Exit.isFailure(yield* Effect.exit(createApprovalDecisions({ store, factories }).resolve(1, "approved")))).toBe(true);
    expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: "plan", status: "queued" }]);
    expect(yield* store.read(`SELECT * FROM integration_intent`)).toEqual([]);
  }));
});

test("scheduler voids multiple stale non-writing evaluations at the earliest stage and creates a fresh assignment", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    // plan is a plain non-writing review; next is a later QA stage. Stage order, not
    // transition insertion order, determines the earliest invalidated stage.
    const stages = [
      { id: "plan", station: "floor.worker", writing: false, approval: false },
      { id: "next", station: "floor.worker", writing: false, approval: false },
      { id: "final", station: "floor.reviewer", writing: false, approval: true },
    ];

    const reviewConfig = { ...gatedConfig, production_lines: { standard: { stages } } };
    const factories = [{ factoryId: "shop", config: reviewConfig }];
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1, end_reason = 'done' WHERE id = ?`, [id]);
      yield* change.query(`UPDATE ticket SET stage = 'final', status = 'queued'`);

      for (const stage of ["next", "plan"]) {
        yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
          from_status, to_state, to_stage, to_status, outcome, git_commit)
          VALUES ('shop', 1, 1, 'worker', 'stage', ?, 'assigned', 'stage', 'final', 'queued', 'done', ?)`, [stage, head]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "reviews" });
    }));
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "changed\n");
    git(path, "commit", "-am", "changed", "--quiet");

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))) };

    const before = yield* snapshot(store);
    expect(Exit.isFailure(yield* Effect.exit(voidStaleApprovals({ store: failing, factories })))).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);
    const assigned = yield* createAssignmentScheduler({ store, slots, factories }).schedule();
    expect(assigned).toMatchObject([{ stage: "plan", slotId: "worker/1" }]);
    expect(assigned[0]?.id).not.toBe(id);
    expect(yield* store.read(`SELECT outcome, to_stage, voided_transitions FROM ticket_transition WHERE outcome = 'voided'`))
      .toMatchObject([{ outcome: "voided", to_stage: "plan", voided_transitions: expect.any(String) }]);
    expect(yield* voidStaleApprovals({ store, factories })).toBe(0);
  }));
});

test("active non-writing work is settled before voiding and a changed Git fence rolls back", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const factories = [{ factoryId: "shop", config: gatedConfig }];
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
        from_status, to_state, to_stage, to_status, outcome, git_commit)
        VALUES ('shop', 1, 1, 'reviewer', 'stage', 'plan', 'assigned', 'stage', 'next', 'assigned', 'done', ?)`, [head]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "evaluation" });
    }));
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "changed\n");
    git(path, "commit", "-am", "changed", "--quiet");
    const before = yield* snapshot(store);
    expect(yield* voidStaleApprovals({ store, factories })).toBe(0);
    expect(yield* snapshot(store)).toEqual(before);
    expect(Exit.isFailure(yield* Effect.exit(voidStaleApprovals({ store, factories, interrupt: async () => {
      writeFileSync(join(path, "tracked.txt"), "changed during settlement\n");
    } })))).toBe(true);
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* voidStaleApprovals({ store, factories, interrupt: async () => {} })).toBe(1);
    expect(yield* store.read(`SELECT id, status, end_reason FROM assignment`)).toEqual([{ id, status: "ended", end_reason: "voided" }]);
    expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: "plan", status: "queued" }]);
  }));
});

test("uninspectable approval blocks only its ticket, not unrelated queued work", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const reviewConfig = { ...gatedConfig, production_lines: { standard: { stages:
      (gatedConfig.production_lines.standard?.stages ?? []).map((stage) => ({ ...stage, station: "floor.worker" })),
    } } };

    const factories = [{ factoryId: "shop", config: reviewConfig }];
    const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(reviewConfig)] });
    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    yield* Effect.promise(() => submissions.submit(owner, { ...frame(id), args: { ...frame(id).args, gitCommit: head } }));
    yield* createApprovalDecisions({ store, factories }).resolve(1, "approved");
    yield* service.submit({ title: "Unrelated", spec: "Disposable", factory: "shop" });
    rmSync(join(root, "worktree"), { recursive: true });
    const errors: Array<unknown> = [];
    const assigned = yield* createAssignmentScheduler({ store, factories, slots, onApprovalError: (cause) => { errors.push(cause); } }).schedule();
    expect(assigned).toMatchObject([{ ticket: 2, stage: "plan" }]);
    expect(errors).toHaveLength(1);
    expect(yield* store.read(`SELECT stage, status FROM ticket WHERE number = 1`)).toEqual([{ stage: "next", status: "queued" }]);
    expect(yield* store.read(`SELECT * FROM ticket_transition WHERE outcome = 'voided'`)).toEqual([]);
  }));
});

test("voiding never interrupts a successor when its assignment changes before reservation", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
        from_status, to_state, to_stage, to_status, outcome, git_commit)
        VALUES ('shop', 1, 1, 'worker', 'stage', 'plan', 'assigned', 'stage', 'next', 'assigned', 'done', ?)`, [head]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "review" });
    }));
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "moved\n");
    git(path, "commit", "-am", "moved", "--quiet");
    let replaced = false;

    const racing: Store = { ...store, change: (body) => Effect.gen(function* () {
      if (!replaced) {
        replaced = true;
        yield* store.change((change) => Effect.gen(function* () {
          yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1, end_reason = 'done' WHERE id = ?`, [id]);
          yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
            SELECT 'successor', factory_id, ticket_number, stage, slot_id, 'active', recovery_ceiling, created_at + 1, context_message FROM assignment WHERE id = ?`, [id]);
          yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slot-reused" });
        }));
      }

      return yield* store.change(body);
    }) };

    let interrupted = false;
    expect(yield* voidStaleApprovals({ store: racing, factories: [{ factoryId: "shop", config: gatedConfig }],
      interrupt: async () => { interrupted = true; } })).toBe(0);
    expect(interrupted).toBe(false);
    expect(yield* store.read(`SELECT id FROM assignment WHERE status = 'active'`)).toEqual([{ id: "successor" }]);
  }));
});

test("voiding reserves slot capacity across settlement and releases it after a competing outcome", async () => {
  await gateFixture(false, false, (store, id, root, head, gatedConfig) => Effect.gen(function* () {
    const reviewConfig = { ...gatedConfig, production_lines: { standard: { stages: [
      { id: "plan", station: "floor.worker", writing: false, approval: false },
      { id: "next", station: "floor.worker", writing: false, approval: false },
      { id: "final", station: "floor.reviewer", writing: false, approval: true },
    ] } } };

    const factories = [{ factoryId: "shop", config: reviewConfig }];
    const service = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(reviewConfig)] });
    yield* service.submit({ title: "Waiting", spec: "Disposable", factory: "shop" });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
        from_status, to_state, to_stage, to_status, outcome, git_commit)
        VALUES ('shop', 1, 1, 'worker', 'stage', 'plan', 'assigned', 'stage', 'next', 'assigned', 'done', ?)`, [head]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "evaluation" });
    }));
    const path = join(root, "worktree");
    writeFileSync(join(path, "tracked.txt"), "changed\n");
    git(path, "commit", "-am", "changed", "--quiet");
    const scheduling = { store, factories, slots: slots.filter((slot) => slot.slotId === owner.slotId) };
    let interruptions = 0;
    expect(yield* voidStaleApprovals({ store, factories, interrupt: async () => {
      interruptions++;
      await Effect.runPromise(store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1, end_reason = 'done' WHERE id = ?`, [id]);
        yield* change.query(`UPDATE ticket SET status = 'paused' WHERE number = 1`);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "concurrent-outcome" });
      })));
      expect(await Effect.runPromise(createAssignmentScheduler(scheduling).schedule())).toEqual([]);
    } })).toBe(0);
    expect(interruptions).toBe(1);
    // The stale sweep made no write, and its ensuring path released the reservation.
    const assigned = yield* createAssignmentScheduler(scheduling).schedule();
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.slotId).toBe(owner.slotId);
  }));
});

test("code stages including final gates refuse missing worktrees without effects", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    for (const stage of ["implement", "review"]) {
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET stage = ?`, [stage]);
        yield* change.query(`UPDATE assignment SET stage = ?`, [stage]);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: stage });
      }));
      const before = yield* snapshot(store);
      expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
        .toMatchObject({ status: "refused", code: "invalid_code_outcome" });
      expect(yield* snapshot(store)).toEqual(before);
    }
  }));
});
