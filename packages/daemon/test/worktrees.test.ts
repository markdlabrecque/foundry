// Integration tier: real disposable Git and SQLite prove creation intent, base and stage reuse.
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit } from "effect";
import { afterEach, expect, test } from "vitest";
import { acknowledgeMessage, assignmentContextSlot, bindStationMessages, createAssignmentScheduler, createMessageDelivery, createTicketService, ensureFactoryClone, listOperations, loadFactoryFiles, LoadFactoriesResult, openSlotGate, openStore, planSlots, ticketFactoryFrom } from "@foundry/daemon";
import type { DaemonFrame } from "@foundry/protocol";
import { MessageReceiver } from "@foundry/extension";
import type { AssignmentSchedulerOptions, LoadedFactory, Store } from "@foundry/daemon";
import { interruptRunningOperations, recoverInterruptedAfterCreate } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";
import { CompactionPrimingOutcome, createPrimer, startChannelServer } from "@foundry/daemon";
import { openChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import { createTicketWorktrees } from "../src/worktrees.js";
import { watchAssignments } from "../src/assignments.js";
import { createWorktreeService } from "../src/worktree-cleanup.js";
import type { WorktreeService } from "../src/worktree-cleanup.js";
import type { HookLogIo } from "../src/before-remove.js";
import { serveManagementApi } from "../src/management-api.js";
import { runWorktreeClean, runWorktreeList } from "@foundry/cli";

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const fixture = async <A, E>(use: (f: {
  store: Store; root: string; clone: string; worktrees: WorktreeService; factory: LoadedFactory;
  tickets: ReturnType<typeof createTicketService>;
  slots: ReturnType<typeof planSlots>;
  scheduler: ReturnType<typeof createAssignmentScheduler>;
  newScheduler: (overrides?: Partial<AssignmentSchedulerOptions>) => ReturnType<typeof createAssignmentScheduler>;
  watch: (onError: (error: Error) => void) => () => Promise<void>;
}) => Effect.Effect<A, E>, settings = "root: ./worktrees", isolation = "worktree", hookLogIo?: HookLogIo) => {
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
      worker: { isolation: ${isolation}, model: fake/model }
${isolation === "none" ? "      final: { isolation: worktree, model: fake/model }\n" : ""}production_lines:
  standard:
    stages:
      - { id: develop, station: floor.worker, writing: ${isolation === "worktree"} }
${isolation === "none" ? "      - { id: implement, station: floor.final, writing: true }\n" : ""}      - { id: review, station: floor.${isolation === "none" ? "final" : "worker"}, approval: true, on_rejection: ${isolation === "none" ? "implement" : "develop"} }
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

    const schedulerOptions = {
      store, slots, factories: [factory],
      prepareWorktree: createTicketWorktrees({ store, target: () => ({ factory, clonePath: clone.path }), env: isolatedGitEnv(), home: root }),
    };

    const newScheduler = (overrides: Partial<AssignmentSchedulerOptions> = {}) => createAssignmentScheduler({ ...schedulerOptions, ...overrides });

    const worktrees = createWorktreeService({ store, stateRoot: root, hookLogIo, target: () => ({ factory, clonePath: clone.path }),
      factories: () => ["shop"], env: isolatedGitEnv() });

    return yield* use({ store, root, clone: clone.path, factory, slots, scheduler: newScheduler(), newScheduler, worktrees, tickets,
      watch: (onError) => watchAssignments(schedulerOptions, onError) });
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

test.each(["worktree", "none"])("compaction restores full unchanged %s context over the channel only while assigned", async (isolation) => {
  await fixture(({ store, root, clone, slots, newScheduler }) => Effect.gen(function* () {
    writeFileSync(join(clone, "AGENTS.md"), "Full repository instructions");
    mkdirSync(join(clone, ".pi", "skills"), { recursive: true });
    writeFileSync(join(clone, ".pi", "APPEND_SYSTEM.md"), "Full appended instructions");
    writeFileSync(join(clone, ".pi", "skills", "review.md"), "---\nname: review\ndescription: Review carefully\n---\nPRIVATE SKILL BODY");
    git(clone, ["add", "."]);
    git(clone, ["commit", "--quiet", "-m", "context fixture"]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO conversation VALUES ('shop', 'worker/1', 'conversation', 'current', 0)`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "conversation" });
    }));
    yield* newScheduler({ clonePath: () => clone }).schedule();
    const slot = { factoryId: "shop", slotId: "worker/1", launchId: "launch" };

    const primer = createPrimer({ store, clonePath: () => clone, primeRequest: () => ({
      address: "floor.worker", slotId: slot.slotId, isolation: isolation === "none" ? "none" : "worktree",
      instructions: [], knowledgeRoot: join(root, "knowledge"), baseDir: root,
    }) });

    const frames: Array<DaemonFrame> = [];
    const delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => { throw cause; } });
    let accepted!: Promise<unknown>;
    let compacted!: Promise<unknown>;

    const server = yield* Effect.promise(() => startChannelServer({
      socketPath: join(root, "channel.sock"),
      slotClaim: { claim: async () => ({ accepted: true, slot }) },
      onAccepted: (claimed, hello, connection) => {
        const primed = primer.prime(claimed, hello, connection);
        accepted = primed.outcome.then(() => delivery.attach(claimed, primed.connection));
      },
      onFrame: (claimed, frame) => {
        if (frame.type === "compacted") {compacted = primer.compacted(claimed);}
      },
    }));

    const waiters: Array<{ count: number; resolve: () => void }> = [];

    const received = (count: number) => new Promise<void>((resolve, reject) => {
      if (frames.length >= count) {
        resolve();

        return;
      }

      const timer = setTimeout(() => reject(new Error(`missing channel frame ${count}`)), 2000);
      waiters.push({ count, resolve: () => { clearTimeout(timer); resolve(); } });
    });

    const opened = yield* Effect.promise(() => openChannel({
      socketPath: server.socketPath,
      hello: { type: "hello", protocolVersion: PROTOCOL_VERSION, ...slot, conversationRef: "conversation",
        hasRecoverableHistory: false, mode: "headless", tools: [] },
      onFrame: (frame) => {
        frames.push(frame);

        for (const waiter of waiters.filter((w) => frames.length >= w.count)) {waiter.resolve();}
      },
    }));

    if (!opened.accepted) {throw new Error("fixture channel refused");}

    const drain = () => Effect.gen(function* () {
      yield* bindStationMessages({ store, slots, contextSlot: assignmentContextSlot });
      yield* Effect.promise(() => delivery.idle());
    });

    const compact = () => Effect.gen(function* () {
      const count = frames.length;
      yield* Effect.promise(() => opened.channel.send({ type: "compacted" }));
      yield* Effect.promise(() => received(count + 1)); // prime proves the report was processed
      expect(yield* Effect.promise(() => compacted)).toMatchObject(CompactionPrimingOutcome.Sent({ primeId: expect.any(String) }));
      yield* drain();
    });

    try {
      yield* Effect.promise(() => received(1));
      yield* Effect.promise(() => accepted);
      yield* drain();
      yield* Effect.promise(() => received(2));
      const first = frames[1];

      if (first?.type !== "message") {throw new Error("assignment message missing");}

      expect(yield* acknowledgeMessage(store, slot, first.id)).toBe(true);
      const initial = yield* store.read<{ parts: string; root: string }>(`SELECT parts, root FROM repository_context`);
      const expectedRoot = isolation === "none" ? clone : join(root, "worktrees", "shop", "1-build-widget");
      expect(initial[0]?.root).toBe(expectedRoot);
      yield* compact();
      yield* Effect.promise(() => received(4));
      expect(frames.map((frame) => frame.type)).toEqual(["prime", "message", "prime", "message"]);
      const restored = frames[3];

      if (restored?.type !== "message") {throw new Error("restored repository context missing");}

      expect(restored.body).toContain(`Root: ${expectedRoot}`);
      expect(restored.body).toContain("Full repository instructions");
      expect(restored.body).toContain("Full appended instructions");
      expect(restored.body).toContain(`Path: ${expectedRoot}/.pi/skills/review.md`);
      expect(restored.body).not.toContain("PRIVATE SKILL BODY");
      expect(yield* acknowledgeMessage(store, slot, restored.id)).toBe(true);
      expect(yield* store.read(`SELECT parts, root FROM repository_context ORDER BY rowid`)).toEqual([initial[0], initial[0]]);

      for (const status of ["suspended", "ended"]) {
        yield* store.change((change) => Effect.gen(function* () {
          yield* change.query(`UPDATE assignment SET status = ?, ended_at = ?`, [status, status === "ended" ? 1 : null]);
          yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: status });
        }));
        yield* compact();
      }

      // Each unassigned compaction still primes, but accepts/sends no context message.
      expect(frames.map((frame) => frame.type)).toEqual(["prime", "message", "prime", "message", "prime", "prime"]);
      expect(yield* store.read(`SELECT COUNT(*) AS count FROM repository_context`)).toEqual([{ count: 2 }]);
      expect(yield* store.read(`SELECT messages_spent FROM ticket`)).toEqual([{ messages_spent: 0 }]);
    } finally {
      opened.channel.close();
      yield* Effect.promise(() => server.close());
      yield* Effect.promise(() => delivery.stop());
    }
  }), "root: ./worktrees", isolation);
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
    expect(yield* store.read(`SELECT kind, subject FROM operator_hold WHERE state = 'open'`)).toEqual([{ kind: "failed_worktree", subject: "1" }]);
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

const finishTicket = (store: Store, state: "completed" | "cancelled" = "cancelled") => store.change((change) => Effect.gen(function* () {
  yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
  yield* change.query(`UPDATE ticket SET state = ?, stage = NULL, status = NULL`, [state]);
  yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "finish" });
}));

test("cleanup is explicit, intent-first, removes merged worktrees and branches, and preserves ticket completion", async () => {
  await fixture(({ store, root, clone, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    const path = join(root, "worktrees/shop/1-build-widget");
    expect((yield* Effect.result(worktrees.clean(undefined, 1)))._tag).toBe("Failure");
    yield* finishTicket(store, "completed");
    expect(existsSync(path)).toBe(true);
    expect(yield* worktrees.list()).toMatchObject({ worktrees: [{ ticket: 1, state: "completed", path }] });
    const observed: Array<boolean> = [];
    const unsubscribe = store.onCommit(() => observed.push(existsSync(path)));

    try {expect(yield* worktrees.clean(undefined, 1)).toMatchObject({ factoryId: "shop", ticket: 1 });}
    finally {unsubscribe();}

    expect(observed).toEqual([true, false]);
    expect(existsSync(path)).toBe(false);
    expect(git(clone, ["branch", "--list", "ticket/1-build-widget"])).toBe("");
    expect(yield* worktrees.list()).toEqual({ worktrees: [] });
    expect(yield* store.read(`SELECT state, start_commit, worktree_path, branch FROM ticket`)).toEqual([
      { state: "completed", start_commit: expect.any(String), worktree_path: null, branch: null },
    ]);
    expect((yield* Effect.result(worktrees.clean(undefined, 1)))._tag).toBe("Failure");
    expect(yield* listOperations(store, "shop")).toMatchObject([{ kind: "worktree_create" }, { kind: "cleanup", status: "complete" }]);
  }));
});

test.each(["tracked", "untracked", "unmerged", "ignored", "whitespace-untracked", "whitespace-ignored"])("cleanup refuses %s work and requires confirmation of the current losses", async (kind) => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const path = join(root, "worktrees/shop/1-build-widget");

    if (kind === "unmerged") {git(path, ["commit", "--quiet", "--allow-empty", "-m", "unmerged work"]);}
    else if (kind === "tracked") {writeFileSync(join(path, "README.md"), "changed tracked work");}
    else if (kind === "ignored" || kind === "whitespace-ignored") {
      const name = kind === "ignored" ? "ignored" : " ignored ";
      writeFileSync(join(path, ".gitignore"), kind === "ignored" ? "ignored\n" : "*ignored*\n");
      git(path, ["add", ".gitignore"]);
      writeFileSync(join(path, name), "work");
    }
    else {writeFileSync(join(path, kind === "whitespace-untracked" ? " precious " : "new.txt"), "work");}

    const inspected = yield* worktrees.inspect(undefined, 1);
    expect(inspected.files !== "" || inspected.commits !== "").toBe(true);
    expect((yield* Effect.result(worktrees.clean(undefined, 1)))._tag).toBe("Failure");
    expect((yield* Effect.result(worktrees.clean(undefined, 1, true)))._tag).toBe("Failure");
    expect(existsSync(path)).toBe(true);

    if (kind === "untracked" || kind === "tracked") {
      writeFileSync(join(path, kind === "tracked" ? "README.md" : "new.txt"), "different contents, same status");
      expect((yield* Effect.result(worktrees.clean(undefined, 1, true, inspected.confirmation)))._tag).toBe("Failure");
    }

    writeFileSync(join(path, "another.txt"), "new loss after inspection");
    expect((yield* Effect.result(worktrees.clean(undefined, 1, true, inspected.confirmation)))._tag).toBe("Failure");
    const current = yield* worktrees.inspect(undefined, 1);
    yield* worktrees.clean(undefined, 1, true, current.confirmation);
    expect(existsSync(path)).toBe(false);
    expect(yield* store.read(`SELECT state FROM ticket`)).toEqual([{ state: "cancelled" }]);
  }));
});

test.each(["--assume-unchanged", "--skip-worktree"])("cleanup refuses changes hidden by %s unless confirmed force", async (flag) => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const path = join(root, "worktrees/shop/1-build-widget");
    git(path, ["update-index", flag, "README.md"]);
    writeFileSync(join(path, "README.md"), "hidden work");
    expect(git(path, ["status", "--porcelain"])).toBe("");
    const inspected = yield* worktrees.inspect(undefined, 1);
    expect(inspected.files).toContain('index flag may hide tracked changes: "README.md"');
    expect((yield* Effect.result(worktrees.clean(undefined, 1)))._tag).toBe("Failure");
    expect(existsSync(path)).toBe(true);
    writeFileSync(join(path, "README.md"), "changed hidden work");
    expect((yield* Effect.result(worktrees.clean(undefined, 1, true, inspected.confirmation)))._tag).toBe("Failure");
    const current = yield* worktrees.inspect(undefined, 1);
    yield* worktrees.clean(undefined, 1, true, current.confirmation);
    expect(existsSync(path)).toBe(false);
  }));
});

test.each(["fifo", "oversized"])("inspection safely refuses %s entries without deleting work", async (kind) => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const path = join(root, "worktrees/shop/1-build-widget");
    const file = join(path, "unsafe-entry");

    if (kind === "fifo") {execFileSync("mkfifo", [file]);}
    else {writeFileSync(file, ""); truncateSync(file, 16 * 1024 * 1024 + 1);}

    expect((yield* Effect.result(worktrees.inspect(undefined, 1)))._tag).toBe("Failure");
    expect((yield* Effect.result(worktrees.clean(undefined, 1, true, "forged")))._tag).toBe("Failure");
    expect(existsSync(file)).toBe(true);
    expect(yield* worktrees.list()).toMatchObject({ worktrees: [{ ticket: 1 }] });
  }));
});

test("cleanup refuses a mismatched worktree identity even when forced", async () => {
  await fixture(({ store, root, clone, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET worktree_path = ?, branch = 'main'`, [clone]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "wrong identity" });
    }));
    expect((yield* Effect.result(worktrees.clean(undefined, 1, true, "forged")))._tag).toBe("Failure");
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(join(root, "worktrees/shop/1-build-widget"))).toBe(true);
  }));
});

test("concurrent clean requests admit one operation and never delete twice", async () => {
  await fixture(({ store, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const results = yield* Effect.all([Effect.result(worktrees.clean(undefined, 1)), Effect.result(worktrees.clean(undefined, 1))], { concurrency: "unbounded" });
    expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
    expect((yield* listOperations(store, "shop")).filter((operation) => operation.kind === "cleanup")).toHaveLength(1);
  }));
});

test.each(["retry", "force"])("failed before_remove preserves artifacts, reports durable output, and supports %s", async (recovery) => {
  await fixture(({ store, root, clone, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store, "completed");
    const path = join(root, "worktrees/shop/1-build-widget");
    // argv is executed directly in the worktree; no shell expansion of this argument.
    writeFileSync(join(root, "cleanup.cjs"), `const fs = require('node:fs');
console.log(process.cwd(), process.argv[2]); console.error('cleanup diagnostic');
process.exit(fs.existsSync('../../../allow-cleanup') ? 0 : 7);\n`);
    const failures: Array<string> = [];
    const observer = new DatabaseSync(join(root, "foundry.db"), { readOnly: true });
    const logsBeforeExecution: Array<boolean> = [];

    const unsubscribe = store.onCommit(() => {
      const hook = observer.prepare(`SELECT id, intent FROM operation WHERE kind = 'hook' AND status = 'running' ORDER BY id DESC LIMIT 1`).get();

      if (hook !== undefined) {
        const intent = JSON.parse(String(hook["intent"]));

        if (intent.logPath !== undefined) {
          // The full intent and output destination must commit before the executable starts.
          logsBeforeExecution.push(existsSync(intent.logPath));
        }
      }
    });

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        failures.push(yield* worktrees.clean(undefined, 1).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "unexpected success" })));
        expect(existsSync(path)).toBe(true);
        expect(git(clone, ["branch", "--list", "ticket/1-build-widget"])).not.toBe("");
        expect(yield* store.read(`SELECT state, worktree_path, branch FROM ticket`)).toEqual([
          { state: "completed", worktree_path: path, branch: "ticket/1-build-widget" },
        ]);
      }
    } finally {unsubscribe(); observer.close();}

    expect(logsBeforeExecution).toEqual([false, false]);
    const hooks = (yield* listOperations(store, "shop")).filter((operation) => operation.kind === "hook");
    expect(hooks).toHaveLength(2);

    for (const [index, hook] of hooks.entries()) {
      const logPath = join(root, "logs/operations", `${hook.id}.log`);
      expect(hook).toMatchObject({ status: "failed", intent: { hook: "before_remove", path }, result: { exitStatus: 7, logPath } });
      expect(failures[index]).toContain(logPath);
      expect(readFileSync(logPath, "utf8")).toBe(`${path} literal $HOME ; untouched\ncleanup diagnostic\n`);
    }

    expect(yield* store.read(`SELECT state, evidence FROM operator_hold ORDER BY id`)).toEqual([
      { state: "resolved", evidence: expect.stringContaining(`"operationId":${hooks[0]?.id}`) },
      { state: "open", evidence: expect.stringContaining(`"operationId":${hooks[1]?.id}`) },
    ]);

    if (recovery === "retry") {
      writeFileSync(join(root, "allow-cleanup"), "yes");
      yield* worktrees.clean(undefined, 1);
    } else {
      const inspected = yield* worktrees.inspect(undefined, 1);
      yield* worktrees.clean(undefined, 1, true, inspected.confirmation);
    }

    expect(existsSync(path)).toBe(false);
    expect(git(clone, ["branch", "--list", "ticket/1-build-widget"])).toBe("");
    expect((yield* listOperations(store, "shop")).filter((operation) => operation.kind === "hook")).toHaveLength(recovery === "retry" ? 3 : 2);
    expect(yield* store.read(`SELECT state FROM operator_hold`)).toEqual([{ state: "resolved" }, { state: "resolved" }]);
    expect(yield* store.read(`SELECT state, worktree_path FROM ticket`)).toEqual([{ state: "completed", worktree_path: null }]);
    expect(readFileSync(join(root, "logs/operations", `${hooks[0]?.id}.log`), "utf8")).toContain("cleanup diagnostic");
  }), `root: ./worktrees, before_remove: [${JSON.stringify(process.execPath)}, ../../../cleanup.cjs, 'literal $HOME ; untouched']`);
});

test("hook-created files are preserved instead of discarded after a successful hook", async () => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const path = join(root, "worktrees/shop/1-build-widget");
    expect(yield* worktrees.clean(undefined, 1).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "unexpected success" }))).toContain("before_remove left");
    expect(readFileSync(join(path, "artifact"), "utf8")).toBe("preserve me");
  }), `root: ./worktrees, before_remove: [${JSON.stringify(process.execPath)}, -e, "require('node:fs').writeFileSync('artifact', 'preserve me')"]`);
});

test("missing before_remove executable raises a failure hold and confirmed force skips it", async () => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    expect(yield* worktrees.clean(undefined, 1).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "unexpected success" }))).toContain("ENOENT");
    expect(existsSync(join(root, "worktrees/shop/1-build-widget"))).toBe(true);
    expect(yield* store.read(`SELECT state FROM operator_hold`)).toEqual([{ state: "open" }]);
    const inspected = yield* worktrees.inspect(undefined, 1);
    yield* worktrees.clean(undefined, 1, true, inspected.confirmation);
  }), 'root: ./worktrees, before_remove: [./missing-cleanup]');
});

test("CLI list and confirmed force traverse the management socket without deleting cancelled work automatically", async () => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const path = join(root, "worktrees/shop/1-build-widget");
    writeFileSync(join(path, "precious.txt"), "keep me");

    const api = yield* Effect.promise(() => serveManagementApi({ stateRoot: root, worktrees,
      status: () => ({ instance: { stateRoot: root, daemonPid: 1, startedAt: "2026-01-01T00:00:00Z" } }),
    }));

    const disclosures: Array<string> = [];
    const common = { home: root, env: {}, factory: undefined, json: false, notice: (text: string) => { disclosures.push(text); } };

    try {
      expect(yield* Effect.promise(() => runWorktreeList(common))).toMatchObject({ exitCode: 0, stdout: expect.stringContaining(path) });
      expect(yield* Effect.promise(() => runWorktreeClean({ ...common, number: 1, force: false, yes: false }))).toMatchObject({ exitCode: 1 });
      expect(yield* Effect.promise(() => runWorktreeClean({ ...common, number: 1, force: true, yes: false, terminal: false }))).toMatchObject({ exitCode: 2 });
      let losses = "";
      expect(yield* Effect.promise(() => runWorktreeClean({ ...common, number: 1, force: true, yes: false, terminal: true,
        confirm: async (text) => {
          losses = text;

          return false;
        },
      }))).toMatchObject({ exitCode: 2 });
      expect(losses).toContain("precious.txt");
      expect(existsSync(path)).toBe(true);
      disclosures.length = 0;
      expect(yield* Effect.promise(() => runWorktreeClean({ ...common, number: 1, force: true, yes: true, json: true,
        notice: (text) => {
          expect(existsSync(path)).toBe(true);
          disclosures.push(text);
        },
      }))).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('"ok":true') });
      expect(disclosures).toHaveLength(1);
      expect(disclosures[0]).toContain("precious.txt");
      expect(disclosures[0]).toContain("Unmerged commits:");
      expect(existsSync(path)).toBe(false);
    } finally {yield* Effect.promise(api.close);}
  }));
});

test.each(["write", "close"])("log %s failure still records a failed hook and allows confirmed force", async (failure) => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    const error = yield* worktrees.clean(undefined, 1).pipe(Effect.match({ onFailure: (cause) => cause.message, onSuccess: () => "unexpected success" }));
    expect(error).toContain(`log ${failure} failed`);
    expect(existsSync(join(root, "worktrees/shop/1-build-widget"))).toBe(true);
    expect((yield* listOperations(store, "shop")).filter((operation) => operation.kind !== "worktree_create")).toMatchObject([
      { kind: "cleanup", status: "failed" }, { kind: "hook", status: "failed" },
    ]);
    expect(yield* store.read(`SELECT state, evidence FROM operator_hold`)).toEqual([
      { state: "open", evidence: expect.stringContaining(`log ${failure} failed`) },
    ]);
    const inspected = yield* worktrees.inspect(undefined, 1);
    yield* worktrees.clean(undefined, 1, true, inspected.confirmation);
    expect(existsSync(inspected.path)).toBe(false);
  }), 'root: ./worktrees, before_remove: [./missing-cleanup]', "worktree", {
    write: (fd, text) => {
      if (failure === "write") {throw new Error("injected ENOSPC");}

      writeSync(fd, text);
    },
    close: (fd) => {
      closeSync(fd);

      if (failure === "close") {throw new Error("injected close failure");}
    },
  });
});

test("signal-terminated before_remove keeps its signal and raises a failure hold", async () => {
  await fixture(({ store, root, scheduler, worktrees }) => Effect.gen(function* () {
    yield* scheduler.schedule();
    yield* finishTicket(store);
    expect(yield* worktrees.clean(undefined, 1).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "unexpected success" }))).toContain("signal SIGTERM");
    expect(existsSync(join(root, "worktrees/shop/1-build-widget"))).toBe(true);
    expect((yield* listOperations(store, "shop")).filter((operation) => operation.kind === "hook")).toMatchObject([
      { status: "failed", result: { exitStatus: null, signal: "SIGTERM" } },
    ]);
    expect(yield* store.read(`SELECT state, evidence FROM operator_hold`)).toEqual([
      { state: "open", evidence: expect.stringContaining('"signal":"SIGTERM"') },
    ]);
  }), `root: ./worktrees, before_remove: [${JSON.stringify(process.execPath)}, -e, "process.kill(process.pid, 'SIGTERM')"]`);
});

test("after_create executes literal argv in the worktree, persists intent and logs, and runs once", async () => {
  const literal = "$(touch injected); * > injected";
  const command = [process.execPath, "-e", `console.log(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(1)})); console.error('setup stderr')`, literal];
  await fixture(({ store, root, scheduler, newScheduler }) => Effect.gen(function* () {
    const scans: Array<Promise<ReadonlyArray<unknown>>> = [];
    let seen = false;
    const observer = new DatabaseSync(join(root, "foundry.db"), { readOnly: true });

    const unsubscribe = store.onCommit(() => {
      if (!seen && observer.prepare(`SELECT 1 FROM operation WHERE kind = 'hook' AND status = 'running'`).get() !== undefined) {
        seen = true;
        scans.push(Effect.runPromise(newScheduler().schedule()));
        expect(observer.prepare(`SELECT count(*) AS n FROM assignment`).get()?.["n"]).toBe(0);
      }
    });

    try {
      const assignments = yield* scheduler.schedule();
      const concurrent = yield* Effect.promise(() => Promise.all(scans));
      expect([...assignments, ...concurrent.flat()]).toHaveLength(1);
      expect(seen).toBe(true);
    } finally {unsubscribe(); observer.close();}

    const hooks = (yield* listOperations(store, "shop")).filter((op) => op.kind === "hook");
    expect(hooks).toMatchObject([{ status: "complete", intent: { hook: "after_create", argv: command }, result: { exitStatus: 0, signal: null } }]);
    const logPath = String(hooks[0]?.intent["logPath"]);
    const path = join(root, "worktrees/shop/1-build-widget");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain(JSON.stringify({ cwd: path, args: [literal] }));
    expect(log).toContain("setup stderr");
    expect(existsSync(join(path, "injected"))).toBe(false);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE ticket SET stage = 'review', status = 'queued'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "next stage" });
    }));
    expect(yield* newScheduler().schedule()).toMatchObject([{ stage: "review" }]);
    expect((yield* listOperations(store, "shop")).filter((op) => op.kind === "hook")).toEqual(hooks);
  }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
});

test.each([
  { name: "failed exit", command: [process.execPath, "-e", "console.log('setup failed'); console.error('diagnostic'); process.exit(17)"], exitStatus: 17 },
  { name: "spawn error", command: ["./missing-setup-command"], exitStatus: null },
])("after_create $name pauses without assignment and exposes durable hook-failure evidence", async ({ command, exitStatus }) => {
  await fixture(({ store, scheduler, newScheduler }) => Effect.gen(function* () {
    expect(yield* scheduler.schedule()).toEqual([]);
    expect(yield* newScheduler().schedule()).toEqual([]);
    expect(yield* store.read(`SELECT state, stage, status FROM ticket`)).toEqual([{ state: "stage", stage: "develop", status: "paused" }]);
    expect(yield* store.read(`SELECT * FROM assignment`)).toEqual([]);
    expect(yield* store.read(`SELECT * FROM message`)).toEqual([]);
    const hooks = (yield* listOperations(store, "shop")).filter((op) => op.kind === "hook");
    expect(hooks).toMatchObject([{ status: "failed", result: { exitStatus } }]);
    const logPath = String(hooks[0]?.intent["logPath"]);
    expect(readFileSync(logPath, "utf8")).toContain(exitStatus === null ? "ENOENT" : "diagnostic");
    const holds = yield* store.read<{ evidence: string }>(`SELECT evidence FROM operator_hold WHERE kind = 'hook_failure' AND subject = '1' AND state = 'open'`);
    expect(holds).toHaveLength(1);
    expect(JSON.parse(holds[0]?.evidence ?? "{}")).toMatchObject({ hook: "after_create", operationId: hooks[0]?.id, exitStatus, logPath });
    expect(yield* store.read(`SELECT to_state, to_status, reason FROM ticket_transition ORDER BY sequence DESC LIMIT 1`))
      .toEqual([{ to_state: "stage", to_status: "paused", reason: "after_create failed" }]);
  }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
});

test("resume retries first setup in the original worktree, records fresh failures and only assigns after success", async () => {
  const command = [process.execPath, '-e', `const fs = require('node:fs'); console.log(process.cwd()); if (!fs.existsSync('setup-ready')) process.exit(17); fs.writeFileSync('setup-complete', 'yes')`];
  await fixture(({ store, root, scheduler, newScheduler, tickets }) => Effect.gen(function* () {
    expect(yield* scheduler.schedule()).toEqual([]);
    const identity = yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`);
    const path = join(root, 'worktrees/shop/1-build-widget');
    writeFileSync(join(path, 'preserved-work'), 'operator repair');
    const observer = new DatabaseSync(join(root, 'foundry.db'), { readOnly: true });
    const scans: Array<Promise<ReadonlyArray<unknown>>> = [];
    const duplicateResumes: Array<Promise<Exit.Exit<unknown, unknown>>> = [];
    const seen = new Set<number>();

    const unsubscribe = store.onCommit(() => {
      const hook = observer.prepare(`SELECT id FROM operation WHERE kind = 'hook' AND status = 'running'`).get();

      if (hook !== undefined && !seen.has(Number(hook['id']))) {
        seen.add(Number(hook['id']));
        expect(observer.prepare(`SELECT count(*) AS n FROM assignment`).get()?.['n']).toBe(0);
        expect(observer.prepare(`SELECT status FROM ticket`).get()?.['status']).toBe('paused');
        scans.push(Effect.runPromise(newScheduler().schedule()));
        duplicateResumes.push(Effect.runPromise(Effect.exit(tickets.resume('shop', 1))));
      }
    });

    try {
      expect((yield* tickets.resume('shop', 1)).ticket.status).toBe('paused');
      expect(yield* Effect.promise(() => Promise.all(scans))).toEqual([[]]);
      expect((yield* Effect.promise(() => Promise.all(duplicateResumes))).every(Exit.isFailure)).toBe(true);
      expect(yield* store.read(`SELECT * FROM assignment`)).toEqual([]);
      expect(yield* store.read(`SELECT * FROM message`)).toEqual([]);
      expect(yield* store.read(`SELECT state FROM operator_hold ORDER BY id`)).toEqual([{ state: 'resolved' }, { state: 'open' }]);
      const failed = (yield* listOperations(store, 'shop')).filter((op) => op.kind === 'hook');
      expect(failed).toHaveLength(2);
      expect(failed.map((op) => op.status)).toEqual(['failed', 'failed']);
      const [hold] = yield* store.read<{ evidence: string }>(`SELECT evidence FROM operator_hold WHERE state = 'open'`);
      expect(JSON.parse(hold?.evidence ?? '{}')).toMatchObject({ operationId: failed[1]?.id, exitStatus: 17 });
      writeFileSync(join(path, 'setup-ready'), 'repaired');
      expect((yield* tickets.resume('shop', 1)).ticket.status).toBe('queued');
      expect(yield* Effect.promise(() => Promise.all(scans))).toEqual([[], []]);
      expect((yield* Effect.promise(() => Promise.all(duplicateResumes))).every(Exit.isFailure)).toBe(true);
    } finally {unsubscribe(); observer.close();}

    expect(seen.size).toBe(2);
    expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual(identity);
    expect(readFileSync(join(path, 'preserved-work'), 'utf8')).toBe('operator repair');
    expect(readFileSync(join(path, 'setup-complete'), 'utf8')).toBe('yes');
    expect(yield* store.read(`SELECT state FROM operator_hold ORDER BY id`)).toEqual([{ state: 'resolved' }, { state: 'resolved' }]);
    const operations = yield* listOperations(store, 'shop');
    expect(operations.filter((op) => op.kind === 'worktree_create')).toHaveLength(1);
    const hooks = operations.filter((op) => op.kind === 'hook');
    expect(hooks.map((op) => op.status)).toEqual(['failed', 'failed', 'complete']);
    expect(new Set(hooks.map((op) => op.intent['logPath'])).size).toBe(3);

    for (const hook of hooks) {
      expect(hook.intent).toMatchObject({ path, argv: command });
      expect(readFileSync(String(hook.intent['logPath']), 'utf8').trim()).toBe(path);
    }

    // A concurrent scan may already have assigned the now-successful setup.
    yield* newScheduler().schedule();
    expect(yield* store.read(`SELECT ticket_number, status FROM assignment`)).toEqual([{ ticket_number: 1, status: 'active' }]);
    expect(yield* store.read(`SELECT to_status FROM ticket_transition WHERE from_status = 'paused' AND to_status = 'queued'`))
      .toEqual([{ to_status: 'queued' }]);
    expect((yield* listOperations(store, 'shop')).filter((op) => op.kind === 'hook')).toEqual(hooks);
  }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
});

test.each([0, 17])('cancellation during setup resume stays final when the retry exits %i', async (exitStatus) => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-resume-cancel-'));
  roots.push(root);
  const socketPath = join(root, 'hook.sock');
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
  const connected = new Promise<Socket>((resolve) => { server.once('connection', resolve); });
  const command = [process.execPath, '-e', `if (!require('node:fs').existsSync('setup-ready')) process.exit(17); const c = require('node:net').connect(${JSON.stringify(socketPath)}); c.on('close', () => process.exit(${exitStatus})); c.resume()`];

  try {
    await fixture(({ store, root, scheduler, newScheduler, tickets }) => Effect.gen(function* () {
      expect(yield* scheduler.schedule()).toEqual([]);
      writeFileSync(join(root, 'worktrees/shop/1-build-widget/setup-ready'), 'retry');
      const resuming = Effect.runPromise(tickets.resume('shop', 1));
      const socket = yield* Effect.promise(() => connected);

      try {
        const cancellation = yield* tickets.inspectCancellation('shop', 1);
        yield* tickets.cancel('shop', 1, cancellation.confirmation);
      } finally {socket.end();}

      expect((yield* Effect.promise(() => resuming)).ticket.state).toBe('cancelled');
      expect(yield* newScheduler().schedule()).toEqual([]);
      expect(yield* store.read(`SELECT * FROM assignment`)).toEqual([]);
      expect(yield* store.read(`SELECT id FROM operator_hold WHERE state = 'open'`)).toEqual([]);
      expect((yield* listOperations(store, 'shop')).filter((op) => op.kind === 'hook').map((op) => op.status))
        .toEqual(['failed', exitStatus === 0 ? 'complete' : 'failed']);
    }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
  } finally {await new Promise<void>((resolve) => { server.close(() => resolve()); });}
});

test("first setup can resume after an earlier non-isolated stage has ended", async () => {
  const command = [process.execPath, '-e', `if (!require('node:fs').existsSync('setup-ready')) process.exit(17)`];
  await fixture(({ store, root, scheduler, newScheduler, tickets }) => Effect.gen(function* () {
    expect(yield* scheduler.schedule()).toMatchObject([{ stage: 'develop', slotId: 'worker/1' }]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1`);
      yield* change.query(`UPDATE ticket SET stage = 'implement', status = 'queued'`);
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition)
        VALUES ('shop', 'final/1', 'floor.final', 1, 'normal')`);
      yield* change.recordHistory({ factoryId: 'shop', kind: 'fixture', subject: 'next stage' });
    }));
    expect(yield* newScheduler().schedule()).toEqual([]);
    expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: 'implement', status: 'paused' }]);
    expect(yield* store.read(`SELECT stage, status FROM assignment`)).toEqual([{ stage: 'develop', status: 'ended' }]);
    const identity = yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`);
    writeFileSync(join(root, 'worktrees/shop/1-build-widget/setup-ready'), 'repaired');
    expect((yield* tickets.resume('shop', 1)).ticket.status).toBe('queued');
    expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual(identity);
    expect(yield* store.read(`SELECT state FROM operator_hold`)).toEqual([{ state: 'resolved' }]);
    expect(yield* newScheduler().schedule()).toMatchObject([{ stage: 'implement', slotId: 'final/1' }]);
    expect((yield* listOperations(store, 'shop')).filter((op) => op.kind === 'hook').map((op) => op.status))
      .toEqual(['failed', 'complete']);
  }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`, 'none');
});

test("a waiting after_create does not block later tickets, and watcher shutdown terminates it", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-hook-listener-"));
  roots.push(root);
  const socketPath = join(root, "hook.sock");
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
  const connected = new Promise<Socket>((resolve) => { server.once("connection", resolve); });
  const command = [process.execPath, "-e", `if (!process.cwd().endsWith('2-next')) { const c = require('node:net').connect(${JSON.stringify(socketPath)}); c.on('data', () => {}); }`];

  try {
    await fixture(({ store, watch }) => Effect.gen(function* () {
      const errors: Array<Error> = [];
      const stop = watch((error) => errors.push(error));
      const socket = yield* Effect.promise(() => connected);
      const closed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); });
      let unsubscribe: (() => void) | undefined;

      const assigned = new Promise<void>((resolve) => {
        unsubscribe = store.onCommit(() => {
          // This read is scheduled after the committing transaction releases its connection.
          void Effect.runPromise(store.read(`SELECT 1 FROM assignment WHERE ticket_number = 2`)).then((rows) => {
            if (rows.length > 0) {resolve();}
          });
        });
      });

      try {
        yield* store.change((change) => Effect.gen(function* () {
          yield* change.query(`INSERT INTO ticket (factory_id, number, title, slug, production_line, directory, state,
            rejection_ceiling, message_ceiling, submitted_at)
            SELECT factory_id, 2, 'Next', 'next', production_line, directory, 'backlog',
              rejection_ceiling, message_ceiling, submitted_at + 1 FROM ticket WHERE number = 1`);
          yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "next ticket" });
        }));
        yield* Effect.promise(() => assigned);
        expect(yield* store.read(`SELECT ticket_number FROM assignment`)).toEqual([{ ticket_number: 2 }]);
        expect((yield* listOperations(store, "shop")).filter((op) => op.kind === "hook"))
          .toMatchObject([{ ticket: 1, status: "running" }, { ticket: 2, status: "complete" }]);
      } finally {unsubscribe?.(); yield* Effect.promise(stop);}

      yield* Effect.promise(() => closed);
      expect(errors).toEqual([]);
      // Interrupted setup remains durable for recovery; shutdown must not fabricate success/failure.
      expect((yield* listOperations(store, "shop")).find((op) => op.kind === "hook" && op.ticket === 1)?.status).toBe("running");
    }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
  } finally {await new Promise<void>((resolve) => { server.close(() => resolve()); });}
});

test.each([
  { outcome: "complete", ready: true },
  { outcome: "failed", ready: false },
])("startup reruns an interrupted after_create in the original worktree and records the rerun's $outcome result", async ({ outcome, ready }) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-hook-rerun-"));
  roots.push(root);
  const socketPath = join(root, "hook.sock");
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
  const connected = new Promise<Socket>((resolve) => { server.once("connection", resolve); });

  // First run blocks until the daemon "dies"; the rerun exits by whether the operator readied setup.
  const command = [process.execPath, "-e", `const fs = require('node:fs'); console.log(process.cwd());
    if (fs.existsSync('rerun')) process.exit(fs.existsSync('setup-ready') ? 0 : 17);
    fs.writeFileSync('rerun', ''); require('node:net').connect(${JSON.stringify(socketPath)}).on('data', () => {})`];

  try {
    await fixture(({ store, root, factory, watch, newScheduler }) => Effect.gen(function* () {
      const stop = watch(() => {});
      const socket = yield* Effect.promise(() => connected);
      const closed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); });
      yield* Effect.promise(stop);
      yield* Effect.promise(() => closed);

      const path = join(root, "worktrees/shop/1-build-widget");
      const identity = yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`);
      writeFileSync(join(path, "preserved-work"), "kept");

      if (ready) {writeFileSync(join(path, "setup-ready"), "yes");}

      const [interrupted] = yield* interruptRunningOperations(store);
      expect(interrupted).toMatchObject({ kind: "hook", status: "interrupted" });
      const reruns = yield* recoverInterruptedAfterCreate({ store, factories: [factory], env: isolatedGitEnv() });

      const operations = yield* listOperations(store, "shop");
      expect(operations.filter((op) => op.kind === "worktree_create")).toHaveLength(1);
      const hooks = operations.filter((op) => op.kind === "hook");
      expect(hooks).toMatchObject([
        { id: interrupted?.id, status: "interrupted", result: { rerun: true, rerunOperationId: reruns[0]?.id } },
        { id: reruns[0]?.id, status: outcome, intent: { path, argv: command, rerunOf: interrupted?.id }, result: { exitStatus: ready ? 0 : 17 } },
      ]);

      // Each run logged its own cwd first; the interrupted one also logs its abort.
      for (const hook of hooks) {expect(readFileSync(String(hook.intent["logPath"]), "utf8").split("\n")[0]).toBe(path);}

      expect(yield* store.read(`SELECT worktree_path, branch, start_commit FROM ticket`)).toEqual(identity);
      expect(readFileSync(join(path, "preserved-work"), "utf8")).toBe("kept");
      // Recovery is settled, so a second startup has nothing to rerun.
      expect(yield* recoverInterruptedAfterCreate({ store, factories: [factory], env: isolatedGitEnv() })).toEqual([]);

      if (ready) {
        expect(yield* newScheduler().schedule()).toMatchObject([{ stage: "develop" }]);
        expect(yield* store.read(`SELECT id FROM operator_hold`)).toEqual([]);
      } else {
        expect(yield* newScheduler().schedule()).toEqual([]);
        expect(yield* store.read(`SELECT * FROM assignment`)).toEqual([]);
        expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: "develop", status: "paused" }]);
        const holds = yield* store.read<{ evidence: string }>(`SELECT evidence FROM operator_hold WHERE kind = 'hook_failure' AND state = 'open'`);
        expect(JSON.parse(holds[0]?.evidence ?? "{}")).toMatchObject({ hook: "after_create", operationId: reruns[0]?.id, exitStatus: 17 });
      }
    }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
  } finally {await new Promise<void>((resolve) => { server.close(() => resolve()); });}
});

test.each([
  { outcome: "complete", ready: true },
  { outcome: "failed", ready: false },
])("startup reruns an interrupted operator retry of after_create as a retry and settles the paused ticket ($outcome)", async ({ outcome, ready }) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-retry-rerun-"));
  roots.push(root);
  const socketPath = join(root, "hook.sock");
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
  const connected = new Promise<Socket>((resolve) => { server.once("connection", resolve); });

  // Run 1 fails, run 2 (the operator retry) blocks until killed, run 3 (the rerun) exits by readiness.
  const command = [process.execPath, "-e", `const fs = require('node:fs');
    const run = (fs.existsSync('runs') ? Number(fs.readFileSync('runs', 'utf8')) : 0) + 1; fs.writeFileSync('runs', String(run));
    if (run === 1) process.exit(17);
    if (run >= 3) process.exit(fs.existsSync('setup-ready') ? 0 : 17);
    require('node:net').connect(${JSON.stringify(socketPath)}).on('data', () => {})`];

  try {
    await fixture(({ store, root, factory, scheduler, newScheduler, tickets }) => Effect.gen(function* () {
      expect(yield* scheduler.schedule()).toEqual([]);
      const controller = new AbortController();
      const resuming = Effect.runPromiseExit(tickets.resume("shop", 1), { signal: controller.signal });
      const socket = yield* Effect.promise(() => connected);
      const closed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); });
      controller.abort();
      yield* Effect.promise(() => resuming);
      yield* Effect.promise(() => closed);

      if (ready) {writeFileSync(join(root, "worktrees/shop/1-build-widget/setup-ready"), "yes");}

      const [interrupted] = yield* interruptRunningOperations(store);
      const reruns = yield* recoverInterruptedAfterCreate({ store, factories: [factory], env: isolatedGitEnv() });
      const hooks = (yield* listOperations(store, "shop")).filter((op) => op.kind === "hook");
      expect(hooks).toMatchObject([
        { status: "failed" },
        { id: interrupted?.id, status: "interrupted", intent: { retryOf: hooks[0]?.id }, result: { rerun: true, rerunOperationId: reruns[0]?.id } },
        { id: reruns[0]?.id, status: outcome, intent: { retryOf: hooks[0]?.id, rerunOf: interrupted?.id } },
      ]);

      if (ready) {
        expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: "develop", status: "queued" }]);
        expect(yield* store.read(`SELECT id FROM operator_hold WHERE state = 'open'`)).toEqual([]);
        expect(yield* newScheduler().schedule()).toMatchObject([{ stage: "develop" }]);
      } else {
        expect(yield* store.read(`SELECT stage, status FROM ticket`)).toEqual([{ stage: "develop", status: "paused" }]);
        const holds = yield* store.read<{ evidence: string }>(`SELECT evidence FROM operator_hold WHERE kind = 'hook_failure' AND state = 'open'`);
        expect(holds).toHaveLength(1);
        expect(JSON.parse(holds[0]?.evidence ?? "{}")).toMatchObject({ hook: "after_create", operationId: reruns[0]?.id, exitStatus: 17 });
        expect(yield* newScheduler().schedule()).toEqual([]);
      }
    }), `root: ./worktrees, after_create: ${JSON.stringify(command)}`);
  } finally {await new Promise<void>((resolve) => { server.close(() => resolve()); });}
});

test("configured tilde root and branch pattern are used", async () => {
  await fixture(({ store, root, scheduler }) => Effect.gen(function* () {
    expect(yield* scheduler.schedule()).toHaveLength(1);
    expect(yield* store.read(`SELECT worktree_path, branch FROM ticket`)).toEqual([
      { worktree_path: join(root, "custom", "shop", "1-build-widget"), branch: "work/build-widget-1" },
    ]);
  }), 'root: ~/custom, branch_pattern: "work/{slug}-{ticket-id}"');
});
