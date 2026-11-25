// Integration tier: real disposable Git and SQLite prove creation intent, base and stage reuse.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { createAssignmentScheduler, createTicketService, ensureFactoryClone, listOperations, loadFactoryFiles, LoadFactoriesResult, openStore, planSlots, ticketFactoryFrom } from "@foundry/daemon";
import type { AssignmentSchedulerOptions, Store } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";
import { createTicketWorktrees } from "../src/worktrees.js";

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const fixture = async <A, E>(use: (f: {
  store: Store; root: string; clone: string;
  scheduler: ReturnType<typeof createAssignmentScheduler>;
  newScheduler: (overrides?: Partial<AssignmentSchedulerOptions>) => ReturnType<typeof createAssignmentScheduler>;
}) => Effect.Effect<A, E>, settings = "root: ./worktrees") => {
  const root = mkdtempSync(join(tmpdir(), "foundry-worktrees-"));
  roots.push(root);
  const source = join(root, "source");
  makeGitSource(source);
  const yamlFile = join(root, "factory.yaml");
  writeFileSync(yamlFile, `version: 1
name: shop
repository: { source: ./source, default_branch: main }
worktrees: { ${settings} }
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
  const slots = planSlots("shop", factory.stations);

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db") });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', 'worker/1', 'floor.worker', 1, 'normal')`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slot" });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(factory.config)] });
    yield* tickets.submit({ title: "Build widget", spec: "Implement widget" }).pipe(Effect.orDie);

    const newScheduler = (overrides: Partial<AssignmentSchedulerOptions> = {}) => createAssignmentScheduler({
      store, slots, factories: [factory],
      prepareWorktree: createTicketWorktrees({ store, target: () => ({ factory, clonePath: clone.path }), env: isolatedGitEnv(), home: root }),
      ...overrides,
    });

    return yield* use({ store, root, clone: clone.path, scheduler: newScheduler(), newScheduler });
  })));
};

test("first isolated assignment uses current clone head, durable intent precedes Git and stages reuse identity", async () => {
  await fixture(({ store, root, clone, scheduler, newScheduler }) => Effect.gen(function* () {
    const path = join(root, "worktrees", "shop", "1-build-widget");
    expect(existsSync(path)).toBe(false);
    // Move the clone after submission. Creation must not use the submission/source head.
    git(clone, ["commit", "--quiet", "--allow-empty", "-m", "clone advances"]);
    const base = git(clone, ["rev-parse", "HEAD"]);
    const observer = new DatabaseSync(join(root, "foundry.db"), { readOnly: true });
    const observed: Array<{ intent: unknown; pathExists: boolean }> = [];

    const unsubscribe = store.onCommit(() => {
      const row = observer.prepare(`SELECT intent FROM operation WHERE kind = 'worktree_create' AND status = 'running'`).get();

      if (row !== undefined) {observed.push({ intent: JSON.parse(String(row["intent"])), pathExists: existsSync(path) });}
    });

    try {
      const scans = yield* Effect.all([scheduler.schedule(), scheduler.schedule()], { concurrency: "unbounded" });
      expect(scans.flat()).toMatchObject([{ ticket: 1, stage: "develop" }]);
    } finally {
      unsubscribe();
      observer.close();
    }

    expect(observed).toEqual([
      { intent: { clonePath: clone, path, branch: "ticket/1-build-widget", defaultBranch: "main" }, pathExists: false },
      { intent: { clonePath: clone, path, branch: "ticket/1-build-widget", defaultBranch: "main", startCommit: base }, pathExists: false },
    ]);
    expect(git(path, ["rev-parse", "HEAD"])).toBe(base);
    expect(git(path, ["branch", "--show-current"])).toBe("ticket/1-build-widget");
    expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual([
      { worktree_path: path, branch: "ticket/1-build-widget", start_commit: base },
    ]);
    // A later stage, with a fresh scheduler, sees the developer's branch and worktree unchanged.
    git(path, ["commit", "--quiet", "--allow-empty", "-m", "implementation"]);
    const developed = git(path, ["rev-parse", "HEAD"]);
    git(clone, ["commit", "--quiet", "--allow-empty", "-m", "clone advances again"]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE ticket SET stage = 'review', status = 'queued'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "next stage" });
    }));
    expect(yield* newScheduler().schedule()).toMatchObject([{ ticket: 1, stage: "review" }]);
    const messages = yield* store.read<{ body: string }>(`SELECT body FROM message ORDER BY sequence`);
    expect(messages).toHaveLength(2);

    for (const message of messages) {expect(message.body).toContain(`Worktree: ${path}`);}

    expect(git(path, ["rev-parse", "HEAD"])).toBe(developed);
    expect(yield* listOperations(store, "shop")).toMatchObject([
      { kind: "worktree_create", status: "complete", intent: { startCommit: base }, result: { path, startCommit: base } },
    ]);
  }));
});

test("a colliding branch is never overwritten or assigned and failed creation is not blindly retried", async () => {
  await fixture(({ store, clone, scheduler }) => Effect.gen(function* () {
    git(clone, ["branch", "ticket/1-build-widget"]);
    const original = git(clone, ["rev-parse", "ticket/1-build-widget"]);
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual([
      { worktree_path: null, branch: null, start_commit: null },
    ]);
    expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "failed", result: { reason: expect.stringContaining("already exists") } }]);
    expect(git(clone, ["rev-parse", "ticket/1-build-widget"])).toBe(original);
    expect(yield* store.read(`SELECT * FROM assignment`)).toEqual([]);
  }));
});

test("configured tilde root and branch pattern are used", async () => {
  await fixture(({ store, root, scheduler }) => Effect.gen(function* () {
    expect(yield* scheduler.schedule()).toHaveLength(1);
    expect(yield* store.read(`SELECT worktree_path, branch FROM ticket`)).toEqual([
      { worktree_path: join(root, "custom", "shop", "1-build-widget"), branch: "work/build-widget-1" },
    ]);
  }), 'root: ~/custom, branch_pattern: "work/{slug}-{ticket-id}"');
});
