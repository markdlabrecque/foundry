// Integration tier: the rule is about what real Git and a real SQLite file hold after a crash
// mid-creation, so each test uses a disposable source, factory clone and database in a temp dir.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import {
  beginOperation, createAssignmentScheduler, createTicketService, createWorktreeRecovery, enqueueOperation, ensureFactoryClone,
  extendOperationIntent, interruptRunningOperations, listOperations, listOperationsAwaitingRecovery, loadFactoryFiles, LoadFactoriesResult,
  openStore, planSlots, recoverInterruptedWorktrees, startNextOperation, ticketFactoryFrom,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const BRANCH = "ticket/1-build-widget";

/**
 * A factory with one submitted ticket whose `worktree_create` crashed after Git made the branch and
 * worktree but before the result committed, and a daemon restart that marked it interrupted.
 */
const interruptedCreation = async <A, E>(use: (f: {
  store: Store; clone: string; path: string; startCommit: string;
  recover: () => ReturnType<typeof recoverInterruptedWorktrees>;
  recovery: () => ReturnType<typeof createWorktreeRecovery>;
  schedule: () => ReturnType<ReturnType<typeof createAssignmentScheduler>["schedule"]>;
}) => Effect.Effect<A, E>, beforeCrash: (path: string, clone: string) => void = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-worktree-recovery-"));
  roots.push(root);
  makeGitSource(join(root, "source"));
  const yamlFile = join(root, "factory.yaml");
  writeFileSync(yamlFile, `version: 1
name: shop
repository: { source: ./source, default_branch: main }
worktrees: { root: ./worktrees }
default_production_line: standard
rooms:
  floor:
    stations:
      worker: { isolation: worktree, model: fake/model }
production_lines:
  standard:
    stages:
      - { id: develop, station: floor.worker, writing: true }
      - { id: review, station: floor.worker, approval: true, on_rejection: develop }
`);
  const loaded = loadFactoryFiles([yamlFile], { env: {} });

  if (LoadFactoriesResult.$is("Refused")(loaded)) {throw new Error(loaded.message);}

  const factory = loaded.factories[0];

  if (factory === undefined) {throw new Error("fixture factory missing");}

  const clone = await ensureFactoryClone(factory, { stateRoot: root, env: isolatedGitEnv() });
  const path = join(root, "worktrees", "shop", "1-build-widget");
  const target = () => ({ factory, clonePath: clone.path });

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db") });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', 'worker/1', 'floor.worker', 1, 'normal')`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slot" });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(factory.config)] });
    yield* tickets.submit({ title: "Build widget", spec: "Implement widget" }).pipe(Effect.orDie);

    // The creation's recorded steps, then Git's, then the crash and the restart's step 1.
    const operation = yield* beginOperation(store, { factoryId: "shop", kind: "worktree_create", ticket: 1,
      intent: { clonePath: clone.path, path, branch: BRANCH, defaultBranch: "main" } });

    const startCommit = git(clone.path, ["rev-parse", "main"]);
    yield* extendOperationIntent(store, operation.id, { startCommit });
    git(clone.path, ["worktree", "add", "--quiet", "-b", BRANCH, "--", path, startCommit]);
    beforeCrash(path, clone.path);
    expect(yield* interruptRunningOperations(store)).toMatchObject([{ id: operation.id, status: "interrupted" }]);

    const scheduler = createAssignmentScheduler({ store, slots: planSlots("shop", factory.stations), factories: [factory] });

    return yield* use({
      store, clone: clone.path, path, startCommit,
      recover: () => recoverInterruptedWorktrees({ store, factories: ["shop"], target, env: isolatedGitEnv() }),
      recovery: () => createWorktreeRecovery({ store, target, env: isolatedGitEnv(), onError: (error) => { throw error; } }),
      schedule: () => scheduler.schedule(),
    });
  }).pipe(Effect.orDie)));
};

test("an empty partial worktree and branch are removed and created again, then the ticket is assignable", async () => {
  await interruptedCreation(({ store, clone, path, startCommit, recover, schedule }) => Effect.gen(function* () {
    // Interrupted creation alone blocks assignment and closes the queue.
    expect(yield* schedule()).toEqual([]);

    // The clone moves on before restart; the recreated branch starts from the new head.
    git(clone, ["commit", "--quiet", "--allow-empty", "-m", "clone advances"]);
    const newHead = git(clone, ["rev-parse", "main"]);
    expect(newHead).not.toBe(startCommit);

    const verdicts = yield* recover();
    expect(verdicts.map((v) => v.verdict)).toEqual(["recreated"]);

    const operations = yield* listOperations(store, "shop");
    expect(operations).toMatchObject([
      { kind: "worktree_create", status: "interrupted", result: { recreated: true, recreateOperationId: operations[1]?.id } },
      { kind: "worktree_create", status: "complete", intent: { recreateOf: operations[0]?.id },
        result: { path, branch: BRANCH, startCommit: newHead } },
    ]);
    expect(yield* listOperationsAwaitingRecovery(store, "shop")).toEqual([]);
    expect(git(path, ["rev-parse", "HEAD"])).toBe(newHead);
    expect(git(path, ["branch", "--show-current"])).toBe(BRANCH);
    expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual([
      { worktree_path: path, branch: BRANCH, start_commit: newHead },
    ]);
    expect(yield* schedule()).toMatchObject([{ ticket: 1, stage: "develop" }]);
  }));
});

test("a partial branch with authored commits is kept and recorded as created, never removed", async () => {
  let authored = "";
  await interruptedCreation(({ store, clone, path, startCommit, recover, schedule }) => Effect.gen(function* () {
    // The clone moves on; the kept branch must stay on its authored history, not be rebuilt.
    git(clone, ["commit", "--quiet", "--allow-empty", "-m", "clone advances"]);

    expect((yield* recover()).map((v) => v.verdict)).toEqual(["kept"]);

    expect(yield* listOperations(store, "shop")).toMatchObject([
      { kind: "worktree_create", status: "complete", result: { path, branch: BRANCH, startCommit, head: authored, recovered: "kept" } },
    ]);
    expect(git(path, ["rev-parse", "HEAD"])).toBe(authored);
    expect(git(clone, ["rev-parse", BRANCH])).toBe(authored);
    expect(git(path, ["log", "-1", "--format=%s"])).toBe("authored work");
    expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual([
      { worktree_path: path, branch: BRANCH, start_commit: startCommit },
    ]);
    expect(yield* schedule()).toMatchObject([{ ticket: 1, stage: "develop" }]);
  }), (path) => {
    writeFileSync(join(path, "widget.txt"), "widget\n");
    git(path, ["add", "widget.txt"]);
    git(path, ["commit", "--quiet", "--no-verify", "-m", "authored work"]);
    authored = git(path, ["rev-parse", "HEAD"]);
  });
});

test("a worktree left locked by a crash inside `git worktree add` is removed and created again", async () => {
  await interruptedCreation(({ store, path, recover, schedule }) => Effect.gen(function* () {
    expect((yield* recover()).map((v) => v.verdict)).toEqual(["recreated"]);
    expect((yield* listOperations(store, "shop")).map((o) => o.status)).toEqual(["interrupted", "complete"]);
    expect(git(path, ["branch", "--show-current"])).toBe(BRANCH);
    expect(yield* schedule()).toMatchObject([{ ticket: 1, stage: "develop" }]);
  }), (path, clone) => { git(clone, ["worktree", "lock", "--reason", "initializing", "--", path]); });
});

test("a branch with commits whose worktree directory is gone is preserved and recorded failed", async () => {
  let authored = "";
  await interruptedCreation(({ store, clone, recover, schedule }) => Effect.gen(function* () {
    expect((yield* recover()).map((v) => v.verdict)).toEqual(["refused"]);
    expect(git(clone, ["rev-parse", BRANCH])).toBe(authored);
    expect(yield* listOperations(store, "shop")).toMatchObject([{ kind: "worktree_create", status: "failed" }]);
    expect(yield* schedule()).toEqual([]);
  }), (path) => {
    writeFileSync(join(path, "widget.txt"), "widget\n");
    git(path, ["add", "widget.txt"]);
    git(path, ["commit", "--quiet", "--no-verify", "-m", "authored work"]);
    authored = git(path, ["rev-parse", "HEAD"]);
    rmSync(path, { recursive: true, force: true });
  });
});

test("a branch checked out in another worktree is never deleted", async () => {
  let moved = "";
  await interruptedCreation(({ store, clone, startCommit, recover }) => Effect.gen(function* () {
    expect((yield* recover()).map((v) => v.verdict)).toEqual(["refused"]);
    expect(git(clone, ["rev-parse", BRANCH])).toBe(startCommit);
    expect(git(moved, ["branch", "--show-current"])).toBe(BRANCH);
    expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "failed" }]);
  }), (path, clone) => {
    git(clone, ["worktree", "remove", "--", path]);
    moved = `${path}-elsewhere`;
    git(clone, ["worktree", "add", "--quiet", "--", moved, BRANCH]);
  });
});

test("once a factory's verdicts are settled, its queued work is admitted", async () => {
  await interruptedCreation(({ store, path, recovery }) => Effect.gen(function* () {
    const queued = yield* enqueueOperation(store, { factoryId: "shop", kind: "sync", intent: { defaultBranch: "main" } });
    expect(yield* startNextOperation(store, "shop")).toBeUndefined();

    const recoverer = recovery();
    const settled = yield* Effect.promise(() => recoverer.settle("shop"));
    expect(settled.map((v) => v.verdict)).toEqual(["recreated"]);
    expect(yield* startNextOperation(store, "shop")).toMatchObject({ id: queued.id, status: "running" });

    // The rebuild finishes in the background after the queue resumed.
    yield* Effect.promise(() => recoverer.idle());
    expect(existsSync(path)).toBe(true);
    yield* Effect.promise(() => recoverer.stop());
  }));
});
