// Integration tier: the claims are about real Git refs and what one SQLite file commits after a
// crash — what recovery reads from the clone's default branch decides the integration's verdict —
// so each case runs real Git in a temp dir against a disposable database, reopened as a restart would.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import {
  createApprovalDecisions, createAssignmentScheduler, createFactorySyncer, createSubmissions, createTicketService, enqueueOperation,
  extendOperationIntent, interruptRunningOperations, listOpenHolds, listOperations, openStore, planSlots,
  recoverInterruptedIntegrations, serveManagementApi, startNextOperation, taskTransitionHandler, ticketFactoryFrom,
} from "@foundry/daemon";
import type { LoadedFactory, Store } from "@foundry/daemon";
import { TASK_TRANSITION } from "@foundry/protocol";
import { expectDefined } from "@foundry/protocol/errors";
import { isolatedGitEnv } from "@foundry/testkit";
import { runIntegrationLanded, runIntegrationNotLanded } from "../../cli/src/tickets.js";
import { FactoryConfig } from "../src/config/schema.js";
import { createWorktreeService } from "../src/worktree-cleanup.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard",
  rooms: { floor: { stations: { worker: {}, reviewer: { isolation: "worktree" } } } },
  production_lines: { standard: { stages: [
    { id: "plan", station: "floor.worker" },
  ] } },
});

/** The plan stage becomes the final approval gate once the ticket is assigned there. */
const gatedConfig = { ...config, production_lines: { standard: { ...config.production_lines.standard, stages: [
  { id: "revise", station: "floor.worker", approval: false, writing: false },
  { id: "plan", station: "floor.reviewer", approval: true, writing: false, on_rejection: "revise" },
] } } };

const factories = [{ factoryId: "shop", config: gatedConfig }];

const slots = planSlots("shop", [{
  address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 1, isolation: "none",
}]);

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: isolatedGitEnv() }).trim();

const commit = (repo: string, file: string, content: string): string => {
  writeFileSync(join(repo, file), content);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", file);

  return git(repo, "rev-parse", "HEAD");
};

const withStore = <A, E>(root: string, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename: join(root, "foundry.db") }), use)));

interface Saved {
  readonly root: string;
  readonly repository: string;
  readonly approved: string;
  /** The default branch head the interrupted run recorded. */
  readonly recordedHead: string;
  readonly scratch: string;
  readonly lock: string;
}

/**
 * A ticket approved at its final gate whose integration the daemon admitted, recorded its intent
 * for, and then died before its result committed. `moved` advances the default branch first.
 */
const interruptedIntegration = async (moved: boolean): Promise<Saved> => {
  const root = mkdtempSync(join(tmpdir(), "foundry-integration-recovery-"));
  roots.push(root);
  const repository = join(root, "repository");
  const path = join(root, "worktree");
  git(root, "init", "--quiet", "--initial-branch=main", repository);
  const base = commit(repository, "tracked.txt", "base\n");
  git(repository, "worktree", "add", "--quiet", "-b", "ticket/1", path);
  const approved = commit(path, "reviewed.txt", "reviewed\n");

  if (moved) {commit(repository, "default.txt", "concurrent\n");}

  const recordedHead = git(repository, "rev-parse", "main");
  const scratch = join(root, "foundry-integration-crash", "merge");
  const lock = join(repository, ".git", "refs", "heads", "ticket", "1.lock");

  await withStore(root, (store) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of slots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', ?, 'worker', ?, 'normal')`,
          [slot.slotId, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
    }));
    yield* createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] })
      .submit({ title: "Plan", spec: "Disposable spec" }).pipe(Effect.orDie);
    const assignmentId = expectDefined((yield* createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config }] }).schedule())[0], "assignment").id;
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'ticket/1', start_commit = ?`, [path, base]);
      yield* change.query(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
        from_state, from_stage, to_state, to_stage, to_status, git_commit)
        VALUES ('shop', 1, 1, 'fixture-writer', 'stage', 'revise', 'stage', 'plan', 'assigned', ?)`, [approved]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "writing complete" });
    }));

    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION, taskTransitionHandler({ factories })]]) });
    expect(yield* Effect.promise(() => submissions.submit({ factoryId: "shop", slotId: "worker/1", launchId: "launch-1" }, {
      type: "tool_call", tool: TASK_TRANSITION, callId: "done-1",
      args: { assignmentId, outcome: "done", reason: "Ready", evidence: ["evidence/plan.md"], gitCommit: approved },
    }))).toMatchObject({ status: "committed" });
    yield* createApprovalDecisions({ store, factories }).resolve(1, "approved");

    // What `integrateApprovedCommit` commits before it touches the default branch.
    const running = expectDefined(yield* startNextOperation(store, "shop"), "admitted integration");
    yield* extendOperationIntent(store, running.id, { branchLock: lock });
    yield* extendOperationIntent(store, running.id, { previousHead: recordedHead, approvedCommit: approved, defaultBranch: "main" });
    yield* extendOperationIntent(store, running.id, { scratchPath: scratch });
  }));

  // The temporary checkout and the ticket-branch lock the run held when it died.
  mkdirSync(join(scratch, ".."), { recursive: true });
  git(repository, "worktree", "add", "--quiet", "--detach", scratch, recordedHead);
  writeFileSync(lock, "");

  return { root, repository, approved, recordedHead, scratch, lock };
};

const loaded: LoadedFactory = { factoryId: "shop", yamlFile: "/disposable/shop.yaml", config: gatedConfig, stations: [],
  warnings: [], configJson: "{}", configHash: "sha256:fixture", knowledge: { root: "/disposable/knowledge", directories: [] } };

/** Restarts: marks the integration interrupted and runs recovery, and the cleanup it starts, against the clone. */
const recoverAfterRestart = (saved: Saved, use: (store: Store) => Effect.Effect<void>) =>
  withStore(saved.root, (store) => Effect.gen(function* () {
    yield* interruptRunningOperations(store);

    const worktrees = createWorktreeService({ store, stateRoot: saved.root, env: isolatedGitEnv(), factories: () => ["shop"],
      target: () => ({ factory: loaded, clonePath: saved.repository }) });

    const recovered = yield* recoverInterruptedIntegrations({ store, env: isolatedGitEnv(), worktrees,
      target: () => ({ clonePath: saved.repository, defaultBranch: "main", config: gatedConfig }) }, "shop");

    expect(recovered).toHaveLength(1);
    yield* use(store);
  }));

const verdictOf = (store: Store) => Effect.map(listOperations(store, "shop"), (operations) => operations[0]);

test.each([
  ["the exact approved commit", false],
  ["a merge of the recorded head and the approved commit", true],
] as const)("an integration whose default branch head is %s landed: it completes and the queue reopens", async (_name, moved) => {
  const saved = await interruptedIntegration(moved);

  if (moved) {
    const tree = git(saved.repository, "merge-tree", "--write-tree", saved.recordedHead, saved.approved);
    const merge = git(saved.repository, "commit-tree", tree, "-p", saved.recordedHead, "-p", saved.approved, "-m", "Integrate");
    git(saved.repository, "merge", "--ff-only", "--quiet", merge);
  } else {
    git(saved.repository, "merge", "--ff-only", "--quiet", saved.approved);
  }

  const head = git(saved.repository, "rev-parse", "main");

  await recoverAfterRestart(saved, (store) => Effect.gen(function* () {
    expect(yield* verdictOf(store)).toMatchObject({ kind: "integration", status: "complete",
      result: { head, approvedCommit: saved.approved, fastForward: !moved, recovered: true } });
    expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "completed", status: null }]);
    expect(yield* store.read(`SELECT git_commit, to_state FROM ticket_transition ORDER BY sequence DESC LIMIT 1`))
      .toEqual([{ git_commit: saved.approved, to_state: "completed" }]);
    expect(yield* listOpenHolds(store)).toEqual([]);
    // The run's ticket-branch lock went with it, so the cleanup it would have run completes.
    expect(existsSync(saved.lock)).toBe(false);
    expect(existsSync(saved.scratch)).toBe(false);
    expect((yield* listOperations(store, "shop")).filter((operation) => operation.kind === "cleanup"))
      .toMatchObject([{ status: "complete", result: { branch: "ticket/1" } }]);
    expect(yield* store.read(`SELECT worktree_path, branch FROM ticket`)).toEqual([{ worktree_path: null, branch: null }]);
    const sync = yield* enqueueOperation(store, { factoryId: "shop", kind: "sync", intent: { defaultBranch: "main" } });
    expect((yield* startNextOperation(store, "shop"))?.id).toBe(sync.id);
  }).pipe(Effect.orDie));

  expect(git(saved.repository, "rev-parse", "main")).toBe(head);
  expect(git(saved.repository, "branch", "--list", "ticket/1")).toBe("");
});

test("an integration whose default branch is still at the recorded head discards its temporary state and reruns from the start", async () => {
  const saved = await interruptedIntegration(false);

  await recoverAfterRestart(saved, (store) => Effect.gen(function* () {
    expect(yield* verdictOf(store)).toMatchObject({ kind: "integration", status: "queued", result: null,
      intent: { approvedCommit: saved.approved } });
    expect(existsSync(saved.scratch)).toBe(false);
    expect(existsSync(saved.lock)).toBe(false);
    expect(git(saved.repository, "worktree", "list", "--porcelain")).not.toContain(saved.scratch);

    // The rerun is an ordinary integration run off the reopened queue.
    yield* Effect.promise(() => createFactorySyncer({ store, env: isolatedGitEnv(),
      target: () => ({ clonePath: saved.repository, defaultBranch: "main", config: gatedConfig }) }).resumeQueued("shop"));
    expect(yield* verdictOf(store)).toMatchObject({ status: "complete", result: { previousHead: saved.recordedHead, head: saved.approved } });
    expect(yield* store.read(`SELECT state FROM ticket`)).toEqual([{ state: "completed" }]);
  }).pipe(Effect.orDie));

  expect(git(saved.repository, "rev-parse", "main")).toBe(saved.approved);
});

test("an integration whose default branch head is unexplained is indeterminate: ticket paused, hold raised, queue closed, branch untouched", async () => {
  const saved = await interruptedIntegration(false);
  const unexplained = commit(saved.repository, "elsewhere.txt", "not Foundry's\n");

  await recoverAfterRestart(saved, (store) => Effect.gen(function* () {
    expect(yield* verdictOf(store)).toMatchObject({ kind: "integration", status: "indeterminate",
      result: { currentHead: unexplained, temporaryWorktree: saved.scratch } });
    expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "stage", status: "paused" }]);
    // The approval and its exact-SHA intent are kept for the operator's declaration.
    expect(yield* store.read(`SELECT approved_commit FROM integration_intent`)).toEqual([{ approved_commit: saved.approved }]);
    expect(yield* listOpenHolds(store)).toMatchObject([{ kind: "indeterminate_integration", subject: "1",
      evidence: { currentHead: unexplained, branchLock: saved.lock, recordedIntent: { previousHead: saved.recordedHead, approvedCommit: saved.approved } } }]);
    yield* enqueueOperation(store, { factoryId: "shop", kind: "sync", intent: { defaultBranch: "main" } });
    expect(yield* startNextOperation(store, "shop")).toBeUndefined();
  }).pipe(Effect.orDie));

  expect(git(saved.repository, "rev-parse", "main")).toBe(unexplained);
});

test("an integration at the recorded head in a clone Git died writing is indeterminate, not rerun on every restart", async () => {
  const saved = await interruptedIntegration(false);
  const indexLock = join(saved.repository, ".git", "index.lock");
  writeFileSync(indexLock, "");

  await recoverAfterRestart(saved, (store) => Effect.gen(function* () {
    expect(yield* verdictOf(store)).toMatchObject({ kind: "integration", status: "indeterminate", result: { currentHead: saved.recordedHead } });
    expect(yield* listOpenHolds(store)).toMatchObject([{ kind: "indeterminate_integration", evidence: { reason: expect.stringContaining(indexLock) } }]);
    yield* enqueueOperation(store, { factoryId: "shop", kind: "sync", intent: { defaultBranch: "main" } });
    expect(yield* startNextOperation(store, "shop")).toBeUndefined();
  }).pipe(Effect.orDie));

  expect(existsSync(indexLock)).toBe(true);
});

/**
 * Restarts into an indeterminate integration, then serves the management API with the ticket
 * service the daemon wires, so the operator's declaration goes through the real CLI client.
 */
const declareAfterRestart = (saved: Saved, use: (store: Store, queue: ReturnType<typeof createFactorySyncer>) => Effect.Effect<void>) =>
  recoverAfterRestart(saved, (store) => Effect.gen(function* () {
    expect(yield* verdictOf(store)).toMatchObject({ status: "indeterminate" });

    const target = () => ({ clonePath: saved.repository, defaultBranch: "main", config: gatedConfig });

    const worktrees = createWorktreeService({ store, stateRoot: saved.root, env: isolatedGitEnv(), factories: () => ["shop"],
      target: () => ({ factory: loaded, clonePath: saved.repository }) });

    const queue = createFactorySyncer({ store, env: isolatedGitEnv(), worktrees, target });

    const tickets = createTicketService({ store, stateRoot: saved.root, factories: () => [ticketFactoryFrom(gatedConfig)],
      integrationTarget: target, worktrees, env: isolatedGitEnv() });

    const api = yield* Effect.promise(() => serveManagementApi({ stateRoot: saved.root,
      status: () => ({ instance: { stateRoot: saved.root, daemonPid: process.pid, startedAt: "fixture" } }), tickets }));

    yield* use(store, queue).pipe(Effect.ensuring(Effect.promise(() => api.close())));
  }).pipe(Effect.orDie));

const declare = (saved: Saved, landed: boolean) => Effect.promise(() =>
  (landed ? runIntegrationLanded : runIntegrationNotLanded)({ home: saved.root, env: {}, factory: "shop", number: 1, json: false }));

test("an indeterminate integration declared landed without its approved commit on the default branch is refused; not landed reruns it from the current head", async () => {
  const saved = await interruptedIntegration(false);
  const unexplained = commit(saved.repository, "elsewhere.txt", "not Foundry's\n");

  await declareAfterRestart(saved, (store, queue) => Effect.gen(function* () {
    const before = yield* store.read(`SELECT * FROM operation`);

    const refused = yield* declare(saved, true);
    expect(refused).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("not an ancestor") });
    // Nothing changed: the integration, the ticket, the hold, the closed queue.
    expect(yield* store.read(`SELECT * FROM operation`)).toEqual(before);
    expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "stage", status: "paused" }]);
    expect(yield* listOpenHolds(store)).toMatchObject([{ kind: "indeterminate_integration", subject: "1" }]);
    expect(git(saved.repository, "rev-parse", "main")).toBe(unexplained);

    expect(yield* declare(saved, false)).toMatchObject({ exitCode: 0 });
    expect(git(saved.repository, "rev-parse", "main")).toBe(unexplained);
    expect(yield* verdictOf(store)).toMatchObject({ status: "queued", result: null,
      intent: { approvedCommit: saved.approved, declaredHead: unexplained } });
    expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "stage", status: "awaiting_approval" }]);
    expect(yield* store.read(`SELECT approved_commit FROM integration_intent`)).toEqual([{ approved_commit: saved.approved }]);
    expect(yield* listOpenHolds(store)).toEqual([]);
    expect(existsSync(saved.lock)).toBe(false);
    expect(existsSync(saved.scratch)).toBe(false);
    // The interrupted run's intent stays in history.
    const [requeued] = yield* store.read<{ detail: string }>(`SELECT detail FROM history WHERE kind = 'operation.requeued'`);
    expect(JSON.parse(expectDefined(requeued, "requeue history").detail)).toMatchObject({ previousIntent: { previousHead: saved.recordedHead } });

    // The rerun is an ordinary integration: it merges the approved commit onto the current head.
    yield* Effect.promise(() => queue.resumeQueued("shop"));
    expect(yield* verdictOf(store)).toMatchObject({ status: "complete", result: { previousHead: unexplained } });
    expect(yield* store.read(`SELECT state FROM ticket`)).toEqual([{ state: "completed" }]);
  }).pipe(Effect.orDie));

  expect(git(saved.repository, "merge-base", "--is-ancestor", unexplained, "main")).toBe("");
  expect(git(saved.repository, "merge-base", "--is-ancestor", saved.approved, "main")).toBe("");
});

test("an indeterminate integration whose approved commit is on the default branch can be declared landed: it completes, cleans up and reopens the queue", async () => {
  const saved = await interruptedIntegration(false);
  git(saved.repository, "merge", "--ff-only", "--quiet", saved.approved);
  // Work on top of the approved commit leaves the head neither the approved commit nor Foundry's merge.
  const head = commit(saved.repository, "after.txt", "later\n");

  await declareAfterRestart(saved, (store) => Effect.gen(function* () {
    expect(yield* declare(saved, true)).toMatchObject({ exitCode: 0 });
    expect(yield* verdictOf(store)).toMatchObject({ kind: "integration", status: "complete",
      result: { head, approvedCommit: saved.approved, declared: "landed" } });
    expect(yield* store.read(`SELECT state, status FROM ticket`)).toEqual([{ state: "completed", status: null }]);
    expect(yield* store.read(`SELECT actor, git_commit, to_state FROM ticket_transition ORDER BY sequence DESC LIMIT 1`))
      .toEqual([{ actor: "operator", git_commit: saved.approved, to_state: "completed" }]);
    expect(yield* listOpenHolds(store)).toEqual([]);
    expect((yield* listOperations(store, "shop")).filter((operation) => operation.kind === "cleanup"))
      .toMatchObject([{ status: "complete", result: { branch: "ticket/1" } }]);
    expect(existsSync(saved.lock)).toBe(false);
    expect(existsSync(saved.scratch)).toBe(false);
    const sync = yield* enqueueOperation(store, { factoryId: "shop", kind: "sync", intent: { defaultBranch: "main" } });
    expect((yield* startNextOperation(store, "shop"))?.id).toBe(sync.id);
    // A second declaration finds nothing indeterminate.
    expect(yield* declare(saved, false)).toMatchObject({ exitCode: 1 });
  }).pipe(Effect.orDie));

  expect(git(saved.repository, "rev-parse", "main")).toBe(head);
  expect(git(saved.repository, "branch", "--list", "ticket/1")).toBe("");
});
