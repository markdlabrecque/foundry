// Integration tier: real disposable Git, hook process and SQLite prove interrupted cleanup recovery (PRD §10.2).
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { beginOperation, createAssignmentScheduler, createTicketService, ensureFactoryClone, interruptRunningOperations, listOperations, listOperationsAwaitingRecovery, loadFactoryFiles, LoadFactoriesResult, openStore, planSlots, ticketFactoryFrom } from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";
import { createTicketWorktrees } from "../src/worktrees.js";
import { createWorktreeService } from "../src/worktree-cleanup.js";
import { reconcileInterruptedCleanups } from "../src/cleanup-recovery.js";

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const BRANCH = "ticket/1-build-widget";

/**
 * A completed ticket with a worktree, a cleanup and before_remove run recorded as running (as a
 * crashed daemon leaves them), then `interruptRunningOperations` as at startup.
 */
type Running = (store: Store, paths: { clone: string; path: string }) => Effect.Effect<unknown, unknown>;

/** The crashed daemon's records, exactly as `clean` writes them before its Git actions. */
const cleanupWithHook: Running = (store, { clone, path }) => Effect.gen(function* () {
  yield* beginOperation(store, { factoryId: "shop", kind: "cleanup", ticket: 1, intent: { path, branch: BRANCH, clonePath: clone, force: false } });
  yield* beginOperation(store, { factoryId: "shop", kind: "hook", ticket: 1, intent: { hook: "before_remove", argv: [], path } });
});

const interruptedCleanup = async <A>(partial: (paths: { root: string; clone: string; path: string }) => void,
  use: (f: { store: Store; root: string; clone: string; path: string; recover: () => ReturnType<typeof reconcileInterruptedCleanups> }) => Effect.Effect<A, unknown>,
  running: Running = cleanupWithHook) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-cleanup-recovery-"));
  roots.push(root);
  makeGitSource(join(root, "source"));
  writeFileSync(join(root, "hook.cjs"), "require('node:fs').appendFileSync('../../../hook-runs', 'run\\n');\n");
  const yamlFile = join(root, "factory.yaml");
  writeFileSync(yamlFile, `version: 1
name: shop
repository: { source: ./source, default_branch: main }
worktrees: { root: ./worktrees, before_remove: [${JSON.stringify(process.execPath)}, ../../../hook.cjs] }
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
  const path = join(root, "worktrees/shop/1-build-widget");
  const target = () => ({ factory, clonePath: clone.path });

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db") });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', 'worker/1', 'floor.worker', 1, 'normal')`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slot" });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(factory.config)] });
    yield* tickets.submit({ title: "Build widget", spec: "Implement widget" }).pipe(Effect.orDie);
    yield* createAssignmentScheduler({ store, slots: planSlots("shop", factory.stations), factories: [factory],
      prepareWorktree: createTicketWorktrees({ store, target, env: isolatedGitEnv(), home: root }) }).schedule();
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE ticket SET state = 'completed', stage = NULL, status = NULL`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "finish" });
    }));
    expect(existsSync(path)).toBe(true);

    yield* running(store, { clone: clone.path, path });
    partial({ root, clone: clone.path, path });
    expect(yield* interruptRunningOperations(store)).toHaveLength(2);

    const worktrees = createWorktreeService({ store, stateRoot: root, target, factories: () => ["shop"], env: isolatedGitEnv() });

    return yield* use({ store, root, clone: clone.path, path,
      recover: () => reconcileInterruptedCleanups({ store, worktrees, target, env: isolatedGitEnv() }, "shop") });
  })));
};

const hookRuns = (root: string) => (existsSync(join(root, "hook-runs")) ? readFileSync(join(root, "hook-runs"), "utf8").split("\n").filter(Boolean).length : 0);

test.each([
  ["directory deleted, registration stale", (p: { clone: string; path: string }) => {rmSync(p.path, { recursive: true, force: true });}],
  ["worktree removed, branch left", (p: { clone: string; path: string }) => {git(p.clone, ["worktree", "remove", "--", p.path]);}],
  ["worktree removed and branch deleted", (p: { clone: string; path: string }) => {
    git(p.clone, ["worktree", "remove", "--", p.path]);
    git(p.clone, ["branch", "-D", "--", BRANCH]);
  }],
])("interrupted cleanup after partial removal (%s) completes safely without rerunning the hook", async (_name, partial) => {
  await interruptedCleanup(partial, ({ store, root, clone, path, recover }) => Effect.gen(function* () {
    expect(yield* recover()).toMatchObject([{ ticket: 1, outcome: "finished" }]);

    expect(existsSync(path)).toBe(false);
    expect(git(clone, ["worktree", "list", "--porcelain"])).not.toContain(path);
    expect(git(clone, ["branch", "--list", BRANCH])).toBe("");
    expect(hookRuns(root)).toBe(0);
    expect(yield* store.read(`SELECT state, worktree_path, branch FROM ticket`)).toEqual([{ state: "completed", worktree_path: null, branch: null }]);
    expect(yield* listOperationsAwaitingRecovery(store, "shop")).toEqual([]);
    expect((yield* listOperations(store, "shop")).filter((o) => o.kind !== "worktree_create")).toMatchObject([
      { kind: "cleanup", status: "complete", result: { path, branch: BRANCH, recovered: true } },
      { kind: "hook", status: "interrupted", result: { reason: "worktree already removed" } },
    ]);
  }));
});

test("interrupted cleanup whose worktree is intact reruns before_remove and removes it", async () => {
  await interruptedCleanup(() => {}, ({ store, root, clone, path, recover }) => Effect.gen(function* () {
    expect(yield* recover()).toMatchObject([{ ticket: 1, outcome: "rerun" }]);

    expect(hookRuns(root)).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(git(clone, ["branch", "--list", BRANCH])).toBe("");
    expect(yield* listOperationsAwaitingRecovery(store, "shop")).toEqual([]);
    const operations = (yield* listOperations(store, "shop")).filter((o) => o.kind !== "worktree_create");
    const rerun = operations[2]?.id;
    expect(operations).toMatchObject([
      { kind: "cleanup", status: "interrupted", result: { rerunAs: rerun } },
      { kind: "hook", status: "interrupted", result: { rerunAs: rerun } },
      { kind: "cleanup", status: "complete" },
      { kind: "hook", status: "complete", intent: { hook: "before_remove", path } },
    ]);
  }));
});

test("a directory-gone cleanup preserves a branch with unmerged commits and records failure", async () => {
  await interruptedCleanup(({ path }) => {
    git(path, ["commit", "--quiet", "--allow-empty", "-m", "unmerged work"]);
    rmSync(path, { recursive: true, force: true });
  }, ({ store, clone, recover }) => Effect.gen(function* () {
    expect(yield* recover()).toMatchObject([{ ticket: 1, outcome: "failed", reason: expect.stringContaining("not in main") }]);

    expect(git(clone, ["branch", "--list", BRANCH])).not.toBe("");
    expect(yield* store.read(`SELECT worktree_path, branch FROM ticket`)).toEqual([{ worktree_path: expect.any(String), branch: BRANCH }]);
    expect(yield* listOperationsAwaitingRecovery(store, "shop")).toEqual([]);
    expect((yield* listOperations(store, "shop")).filter((o) => o.kind === "cleanup")).toMatchObject([{ status: "failed" }]);
  }));
});

test("interrupted cleanup that died inside git worktree remove deletes the half-removed directory and completes", async () => {
  await interruptedCleanup(({ path }) => {
    unlinkSync(join(path, "README.md"));
    unlinkSync(join(path, ".git"));
  }, ({ store, root, clone, path, recover }) => Effect.gen(function* () {
    expect(yield* recover()).toMatchObject([{ ticket: 1, outcome: "finished" }]);

    expect(existsSync(path)).toBe(false);
    expect(git(clone, ["worktree", "list", "--porcelain"])).not.toContain(path);
    expect(git(clone, ["branch", "--list", BRANCH])).toBe("");
    expect(hookRuns(root)).toBe(0);
    expect(yield* store.read(`SELECT state, worktree_path, branch FROM ticket`)).toEqual([{ state: "completed", worktree_path: null, branch: null }]);
    expect(yield* listOperationsAwaitingRecovery(store, "shop")).toEqual([]);
    expect((yield* listOperations(store, "shop")).filter((o) => o.kind === "cleanup")).toMatchObject([{ status: "complete", result: { recovered: true } }]);
  }));
});

test("a directory-gone cleanup whose ticket no longer records its worktree changes no Git state", async () => {
  await interruptedCleanup(({ path }) => {rmSync(path, { recursive: true, force: true });}, ({ store, clone, path, recover }) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = NULL, branch = NULL`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "forget" });
    }));

    expect(yield* recover()).toMatchObject([{ ticket: 1, outcome: "failed", reason: expect.stringContaining("no longer records") }]);

    expect(git(clone, ["worktree", "list", "--porcelain"])).toContain(path);
    expect(git(clone, ["branch", "--list", BRANCH])).not.toBe("");
    expect((yield* listOperations(store, "shop")).filter((o) => o.kind === "cleanup")).toMatchObject([{ status: "failed" }]);
  }));
});

test("an orphan before_remove run is closed while an interrupted after_create still awaits its own recovery", async () => {
  await interruptedCleanup(() => {}, ({ store, recover }) => Effect.gen(function* () {
    expect(yield* recover()).toEqual([]);

    expect(yield* listOperationsAwaitingRecovery(store, "shop")).toMatchObject([
      { kind: "hook", intent: { hook: "after_create", operation: "worktree_create" } },
    ]);
    expect((yield* listOperations(store, "shop")).filter((o) => o.intent["hook"] === "before_remove")).toMatchObject([
      { status: "interrupted", result: { reason: "no interrupted cleanup to rerun it" } },
    ]);
  }), (store, { path }) => Effect.gen(function* () {
    yield* beginOperation(store, { factoryId: "shop", kind: "hook", ticket: 1, intent: { hook: "after_create", operation: "worktree_create", argv: ["true"], path } });
    yield* beginOperation(store, { factoryId: "shop", kind: "hook", ticket: 1, intent: { hook: "before_remove", argv: [], path } });
  }));
});
