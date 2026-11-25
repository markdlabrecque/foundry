// Integration tier: real disposable Git and SQLite prove creation intent, base and stage reuse.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { acknowledgeMessage, assignmentContextSlot, bindStationMessages, createAssignmentScheduler, createMessageDelivery, createTicketService, ensureFactoryClone, listOperations, loadFactoryFiles, LoadFactoriesResult, openSlotGate, openStore, planSlots, ticketFactoryFrom } from "@foundry/daemon";
import type { DaemonFrame } from "@foundry/protocol";
import { MessageReceiver } from "@foundry/extension";
import type { AssignmentSchedulerOptions, Store } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";
import { createTicketWorktrees } from "../src/worktrees.js";

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const fixture = async <A, E>(use: (f: {
  store: Store; root: string; clone: string;
  slots: ReturnType<typeof planSlots>;
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

    return yield* use({ store, root, clone: clone.path, slots, scheduler: newScheduler(), newScheduler });
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

test("assignments send the branch's changed context, skip received hashes and scope receipts to a conversation", async () => {
  await fixture(({ store, root, clone, slots, newScheduler }) => Effect.gen(function* () {
    writeFileSync(join(clone, "AGENTS.md"), "Default branch instructions");
    git(clone, ["add", "AGENTS.md"]);
    git(clone, ["commit", "--quiet", "-m", "repository context"]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO conversation VALUES ('shop', 'worker/1', 'first', 'current', 0)`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "conversation" });
    }));
    const scheduler = () => newScheduler({ clonePath: () => clone });
    const path = join(root, "worktrees", "shop", "1-build-widget");
    const received: Array<DaemonFrame> = [];
    const errors: Array<unknown> = [];
    const turns: Array<string> = [];

    // Exercise the extension's real turn-triggering boundary. The first injection
    // that can start a turn must contain both the assignment and its current context.
    const receiver = new MessageReceiver({ pending: () => [], inject: (injection, options) => {
      if (options?.triggerTurn) {turns.push(injection.content);}
    } });

    const delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => errors.push(cause) });
    const slot = { factoryId: "shop", slotId: "worker/1", launchId: "launch" };
    delivery.attach(slot, { send: async (frame) => {
      received.push(frame);

      if (frame.type === "message") {receiver.receive(frame);}
    } });

    const drain = () => Effect.gen(function* () {
      yield* bindStationMessages({ store, slots, contextSlot: assignmentContextSlot });
      yield* Effect.promise(() => delivery.idle());

      for (const frame of received.splice(0)) {
        if (frame.type === "message") {expect(yield* acknowledgeMessage(store, slot, frame.id)).toBe(true);}
      }
    });

    const nextStage = () => store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE ticket SET stage = 'review', status = 'queued'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "next stage" });
    }));

    const contexts = () => store.read<{ body: string; parts: string; conversation_ref: string }>(
      `SELECT m.body, r.parts, r.conversation_ref FROM repository_context r JOIN message m ON m.id = r.message_id ORDER BY m.sequence`,
    );

    try {
      expect(yield* scheduler().schedule()).toHaveLength(1);
      yield* drain();
      const first = yield* contexts();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toContain("Ticket 1: Build widget");
      expect(turns[0]).toContain("Default branch instructions");
      expect(first).toMatchObject([{ body: expect.stringContaining("Default branch instructions"), conversation_ref: "first" }]);
      expect(JSON.parse(first[0]?.parts ?? "[]")).toEqual([{ path: "AGENTS.md", hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }]);
      // Commit context on the ticket's branch only, while the factory default stays unchanged.
      writeFileSync(join(path, "AGENTS.md"), "Branch instructions for review");
      mkdirSync(join(path, ".pi", "skills"), { recursive: true });
      writeFileSync(join(path, ".pi", "skills", "review.md"), "---\nname: review\ndescription: Review this branch\n---\nSECRET SKILL BODY");
      git(path, ["add", "."]);
      git(path, ["commit", "--quiet", "-m", "branch context changes"]);
      yield* nextStage();
      expect(yield* scheduler().schedule()).toMatchObject([{ stage: "review" }]);
      yield* drain();
      const changed = yield* contexts();
      expect(turns).toHaveLength(2);
      expect(turns[1]).toContain("Stage: review");
      expect(turns[1]).toContain("Branch instructions for review");
      expect(changed).toHaveLength(2);
      expect(changed[1]?.body).toContain("Branch instructions for review");
      expect(changed[1]?.body).toContain(`Path: ${path}/.pi/skills/review.md`);
      expect(changed[1]?.body).not.toContain("SECRET SKILL BODY");
      expect(changed[1]?.parts).not.toBe(changed[0]?.parts);
      // A new scheduler still skips the acknowledged equivalent set. Skill bodies aren't injected.
      writeFileSync(join(path, ".pi", "skills", "review.md"), "---\nname: review\ndescription: Review this branch\n---\nCHANGED BODY");
      yield* nextStage();
      yield* scheduler().schedule();
      yield* drain();
      expect(yield* contexts()).toEqual(changed);
      // Removing all context must send an explicit empty set, not leave stale instructions.
      rmSync(join(path, "AGENTS.md"));
      rmSync(join(path, ".pi"), { recursive: true });
      yield* nextStage();
      yield* scheduler().schedule();
      yield* drain();
      expect(yield* contexts()).toMatchObject([{}, {}, { parts: "[]", body: expect.stringContaining("No repository context files") }]);
      // Reset conversations don't inherit another conversation's deduplication cache.
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE conversation SET status = 'discarded'`);
        yield* change.query(`INSERT INTO conversation VALUES ('shop', 'worker/1', 'second', 'current', 1)`);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "reset" });
      }));
      yield* nextStage();
      yield* scheduler().schedule();
      yield* drain();
      expect(yield* contexts()).toMatchObject([{}, {}, {}, { conversation_ref: "second", parts: "[]" }]);
      expect(yield* store.read(`SELECT messages_spent FROM ticket`)).toEqual([{ messages_spent: 0 }]);
      expect(errors).toEqual([]);
    } finally {
      yield* Effect.promise(() => delivery.stop());
    }
  }));
});

test("equivalent skill headers in two tickets refresh their effective worktree paths", async () => {
  await fixture(({ store, root, clone, slots, newScheduler }) => Effect.gen(function* () {
    const skill = join(".pi", "skills", "review.md");
    const header = "---\nname: review\ndescription: Review this branch\n---\n";
    mkdirSync(join(clone, ".pi", "skills"), { recursive: true });
    writeFileSync(join(clone, skill), `${header}SECOND TICKET BODY`);
    git(clone, ["add", "."]);
    git(clone, ["commit", "--quiet", "-m", "indexed skill"]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO conversation VALUES ('shop', 'worker/1', 'shared', 'current', 0)`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "conversation" });
    }));
    const scheduler = () => newScheduler({ clonePath: () => clone });
    yield* scheduler().schedule();
    const firstPath = join(root, "worktrees", "shop", "1-build-widget");
    writeFileSync(join(firstPath, skill), `${header}FIRST TICKET BODY`);
    const delivered: Array<DaemonFrame> = [];
    const delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => { throw cause; } });
    const slot = { factoryId: "shop", slotId: "worker/1", launchId: "launch" };
    delivery.attach(slot, { send: async (frame) => { delivered.push(frame); } });

    const drain = () => Effect.gen(function* () {
      yield* bindStationMessages({ store, slots, contextSlot: assignmentContextSlot });
      yield* Effect.promise(() => delivery.idle());

      for (const frame of delivered.splice(0)) {
        if (frame.type === "message") {yield* acknowledgeMessage(store, slot, frame.id);}
      }
    });

    try {
      yield* drain();
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
        yield* change.query(`UPDATE ticket SET status = 'paused'`);
        yield* change.query(`INSERT INTO ticket (factory_id, number, title, slug, production_line, directory, state,
          rejection_ceiling, message_ceiling, submitted_at)
          SELECT factory_id, 2, 'Next widget', 'next-widget', production_line, directory, 'backlog',
            rejection_ceiling, message_ceiling, submitted_at + 1 FROM ticket WHERE number = 1`);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "next ticket" });
      }));
      expect(yield* scheduler().schedule()).toMatchObject([{ ticket: 2, slotId: "worker/1" }]);
      yield* drain();

      const contexts = yield* store.read<{ body: string; parts: string }>(
        `SELECT m.body, r.parts FROM repository_context r JOIN message m ON m.id = r.message_id ORDER BY m.sequence`,
      );

      expect(contexts).toHaveLength(2);
      const secondPath = join(root, "worktrees", "shop", "2-next-widget");
      expect(contexts[0]?.body).toContain(`Path: ${firstPath}/${skill}`);
      expect(contexts[1]?.body).toContain(`Path: ${secondPath}/${skill}`);
      expect(contexts[1]?.body).not.toContain(firstPath);
      expect(contexts[1]?.parts).not.toBe(contexts[0]?.parts);
      expect(contexts[1]?.body).not.toContain("SECOND TICKET BODY");
    } finally {
      yield* Effect.promise(() => delivery.stop());
    }
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

test("failed creation does not reserve capacity needed by a later ticket", async () => {
  await fixture(({ store, root, clone, scheduler }) => Effect.gen(function* () {
    git(clone, ["branch", "ticket/1-build-widget"]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO ticket (factory_id, number, title, slug, production_line, directory, state,
        rejection_ceiling, message_ceiling, submitted_at)
        SELECT factory_id, 2, 'Next widget', 'next-widget', production_line, directory, 'backlog',
          rejection_ceiling, message_ceiling, submitted_at + 1 FROM ticket WHERE number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "second ticket" });
    }));
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* scheduler.schedule()).toMatchObject([{ ticket: 2 }]);
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* listOperations(store, "shop")).toMatchObject([
      { ticket: 1, status: "failed" }, { ticket: 2, status: "complete" },
    ]);
    expect(git(join(root, "worktrees", "shop", "2-next-widget"), ["branch", "--show-current"])).toBe("ticket/2-next-widget");
  }));
});

test("lifecycle and readiness gates prevent creation and are rechecked after preparation", async () => {
  await fixture(({ store, newScheduler }) => Effect.gen(function* () {
    expect(yield* newScheduler({ inScope: () => false }).schedule()).toEqual([]);
    expect(yield* newScheduler({ ready: () => false }).schedule()).toEqual([]);
    expect(yield* listOperations(store, "shop")).toEqual([]);
    // onCommit changes lifecycle precisely when the operation completes, before the second scan.
    let running = true;
    const unsubscribe = store.onCommit(() => { running = false; });

    try {
      expect(yield* newScheduler({ inScope: () => running }).schedule()).toEqual([]);
    } finally {
      unsubscribe();
    }

    expect(yield* listOperations(store, "shop")).toMatchObject([{ status: "complete" }]);
    expect(yield* store.read(`SELECT * FROM assignment`)).toEqual([]);
    expect(yield* newScheduler().schedule()).toHaveLength(1);
    expect(yield* listOperations(store, "shop")).toHaveLength(1);
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
