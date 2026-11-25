// Integration tier: disposable SQLite proves ownership, atomic submissions and a durable queue.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import {
  agentDelegateHandler, createAssignmentScheduler, createSubmissions, createTicketService, openStore, planSlots,
  StoreError, taskTransitionHandler, ticketFactoryFrom,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { TASK_TRANSITION } from "@foundry/protocol";
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
  transitions: store.read(`SELECT * FROM ticket_transition`), history: store.read(`SELECT * FROM history`),
  submissions: store.read(`SELECT * FROM submission`), messages: store.read(`SELECT * FROM message`),
  delegations: store.read(`SELECT * FROM delegation ORDER BY accepted_at, rowid`),
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
      { ...frame(id).args, ticket: 99 }, { ...frame(id).args, outcome: "rejected" },
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
  { label: "non-final approval", approval: true, writing: false, station: "floor.worker" },
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
      .toMatchObject({ status: "refused", code: "unsupported_transition" });
    expect(yield* snapshot(store)).toEqual(before);
  }));
});

test.each([
  { mode: "moved", writing: false, code: "non_writing_changes" },
  { mode: "mixed moved", writing: false, code: "non_writing_changes" },
  { mode: "mixed dirty", writing: false, code: "non_writing_changes" },
  { mode: "mixed wrong commit", writing: false, code: "invalid_code_outcome" },
  { mode: "mixed clean", writing: false, code: null },
  { mode: "race before transaction", writing: false, code: "invalid_code_outcome" },
  { mode: "race during writes", writing: false, code: "invalid_code_outcome" },
  { mode: "dirty", writing: false, code: "non_writing_changes" },
  { mode: "staged", writing: false, code: "non_writing_changes" },
  { mode: "missing commit", writing: true, code: "commit_required" },
  { mode: "wrong commit", writing: true, code: "invalid_code_outcome" },
  { mode: "wrong branch", writing: false, code: "invalid_code_outcome" },
  { mode: "clean", writing: false, code: null },
  { mode: "untracked", writing: false, code: null },
  { mode: "new commit", writing: true, code: null },
])("real Git $mode (writing=$writing) preserves assignment on refusal", async ({ mode, writing, code }) => {
  await fixture((store, id, root) => Effect.gen(function* () {
    const repository = join(root, "repository");
    const path = join(root, "worktree");
    git(root, "init", "--quiet", "--initial-branch=main", repository);
    writeFileSync(join(repository, "tracked.txt"), "original\n");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "base");
    const base = git(repository, "rev-parse", "HEAD");
    git(repository, "worktree", "add", "--quiet", "-b", "ticket/1", path);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'ticket/1', start_commit = ?`, [path, base]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "worktree" });
    }));

    const codeConfig = { ...config, production_lines: { standard: {
      ...config.production_lines.standard,
      stages: [{ id: "plan", station: mode.startsWith("mixed") ? "floor.worker" : "floor.reviewer", approval: false, writing },
        { id: "next", station: "floor.worker", approval: false, writing: false }],
    } } };

    const codeHandlers = new Map([[TASK_TRANSITION, taskTransitionHandler({ factories: [{ factoryId: "shop", config: codeConfig }] })]]);

    if (["moved", "mixed moved", "mixed dirty", "new commit", "dirty", "staged"].includes(mode)) {
      writeFileSync(join(path, "tracked.txt"), "changed\n");

      if (!mode.endsWith("dirty")) {git(path, "add", ".");}

      if (mode.endsWith("moved") || mode === "new commit") {git(path, "commit", "--quiet", "-m", "worker change");}
    }

    if (mode === "untracked") {writeFileSync(join(path, "notes.txt"), "not tracked\n");}

    if (mode === "wrong branch") {git(path, "checkout", "--quiet", "-b", "other");}

    const head = git(path, "rev-parse", "HEAD");
    const gitCommit = mode === "missing commit" ? {} : { gitCommit: mode.endsWith("wrong commit") ? "not-a-commit" : head };
    const outcome = { ...frame(id), args: { assignmentId: id, outcome: "done", reason: "Code evaluated", evidence: ["evidence/tests.md"], ...gitCommit } } as const;
    const before = yield* snapshot(store);

    const submissionStore: Store = mode.startsWith("race") ? { ...store, change: (body) => store.change((change) => Effect.gen(function* () {
      if (mode === "race before transaction") {writeFileSync(join(path, "tracked.txt"), "raced\n");}

      return yield* body({ ...change, query: (sql, params) => {
        if (mode === "race during writes" && sql.startsWith("UPDATE assignment")) {writeFileSync(join(path, "tracked.txt"), "raced\n");}

        return change.query(sql, params);
      } });
    })) } : store;

    const submissions = createSubmissions({ store: submissionStore, handlers: codeHandlers });
    const result = yield* Effect.promise(() => submissions.submit(owner, outcome));

    if (code !== null) {
      expect(result).toMatchObject({ status: "refused", code });
      expect(yield* snapshot(store)).toEqual(before);
    } else {
      expect(result).toMatchObject({ status: "committed", value: { stage: "next", status: "queued" } });
      const after = yield* snapshot(store);
      expect(after.assignments).toMatchObject([{ status: "ended", end_reason: "done" }]);
      expect(after.transitions.at(-1)).toMatchObject({ git_commit: head, outcome: "done" });
      // Even if the worktree disappears, a retry returns the durable result.
      git(repository, "worktree", "remove", "--force", path);
      expect(yield* Effect.promise(() => submissions.submit(owner, outcome))).toEqual(result);
      expect(yield* snapshot(store)).toEqual(after);
    }
  }));
});

test("approval/final workflows and missing worktrees fail closed without effects", async () => {
  await fixture((store, id) => Effect.gen(function* () {
    for (const stage of ["implement", "review"]) {
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET stage = ?`, [stage]);
        yield* change.query(`UPDATE assignment SET stage = ?`, [stage]);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: stage });
      }));
      const before = yield* snapshot(store);
      expect(yield* Effect.promise(() => createSubmissions({ store, handlers }).submit(owner, frame(id))))
        .toMatchObject({ status: "refused", code: stage === "implement" ? "invalid_code_outcome" : "unsupported_transition" });
      expect(yield* snapshot(store)).toEqual(before);
    }
  }));
});
