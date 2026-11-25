// Integration tier: the claims are about what one real SQLite file commits and keeps — intent
// before the action, records that survive reopening, and one running queue entry per factory — so
// each test opens a disposable database in a temp dir. A separate `node:sqlite` connection reads
// what is committed, which the store's own connection could not prove.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit } from "effect";
import {
  beginOperation,
  enqueueOperation,
  getOperation,
  listOperations,
  openStore,
  recordOperationResult,
  runOperation,
  startNextOperation,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";

let dir: string;
let filename: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foundry-operations-"));
  filename = join(dir, "foundry.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Opens the store for one use and closes it again, as a daemon run would. */
const withStore = <A, E>(use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename }), use)));

/** What another connection sees committed in the file right now. */
const committedOperations = () => {
  const db = new DatabaseSync(filename, { readOnly: true });

  try {
    return db.prepare(`SELECT id, factory_id, kind, status, intent FROM operation ORDER BY id`).all();
  } finally {
    db.close();
  }
};

const integration = (factoryId: string, ticket: number) => ({
  factoryId,
  kind: "integration" as const,
  ticket,
  intent: { approvedCommit: `c${ticket}`, defaultHead: "h0" },
});

test("an operation's intent is committed as running before its action starts, and its result after", async () => {
  const seen = await withStore((store) =>
    Effect.gen(function* () {
      yield* enqueueOperation(store, integration("f1", 7));
      const started = yield* startNextOperation(store, "f1");
      let duringAction: ReadonlyArray<unknown> = [];

      const finished = yield* runOperation(store, started!, () =>
        Effect.sync(() => {
          duringAction = committedOperations();

          return { status: "complete" as const, result: { mergedCommit: "m1" } };
        }),
      );

      return { duringAction, finished, history: yield* store.read(`SELECT kind FROM history ORDER BY sequence`) };
    }),
  );

  expect(seen.duringAction).toEqual([
    { id: 1, factory_id: "f1", kind: "integration", status: "running", intent: '{"approvedCommit":"c7","defaultHead":"h0"}' },
  ]);
  expect(seen.finished).toMatchObject({ status: "complete", result: { mergedCommit: "m1" }, ticket: 7 });
  expect(seen.history).toEqual([{ kind: "operation.queued" }, { kind: "operation.started" }, { kind: "operation.complete" }]);
});

test("after a restart the stored operations read back as they were, with nothing replayed", async () => {
  await withStore((store) =>
    Effect.gen(function* () {
      yield* enqueueOperation(store, integration("f1", 1));
      yield* enqueueOperation(store, { factoryId: "f1", kind: "sync", intent: { recordedHead: "h0" } });
      yield* startNextOperation(store, "f1");
      // The daemon dies mid-action: the running integration has no result.
      yield* beginOperation(store, { factoryId: "f1", kind: "worktree_create", ticket: 2, intent: { path: "/w/2" } });
    }),
  );

  const reopened = await withStore((store) =>
    Effect.all({ operations: listOperations(store, "f1"), next: startNextOperation(store, "f1") }),
  );

  expect(reopened.operations).toMatchObject([
    { id: 1, kind: "integration", status: "running", ticket: 1, intent: { approvedCommit: "c1" }, result: null },
    { id: 2, kind: "sync", status: "queued", ticket: null, intent: { recordedHead: "h0" }, startedAt: null },
    { id: 3, kind: "worktree_create", status: "running", ticket: 2, intent: { path: "/w/2" } },
  ]);
  // The queue stays closed behind the stored running integration; the sync stays queued.
  expect(reopened.next).toBeUndefined();
});

test("one factory never has two integration or sync operations running at once", async () => {
  const result = await withStore((store) =>
    Effect.gen(function* () {
      for (const ticket of [1, 2, 3]) {yield* enqueueOperation(store, integration("f1", ticket));}

      yield* enqueueOperation(store, { factoryId: "f1", kind: "sync", intent: {} });
      yield* enqueueOperation(store, integration("f2", 1));

      // Many admissions race for the same factories.
      const admitted = yield* Effect.all(
        Array.from({ length: 10 }, (_, i) => startNextOperation(store, i % 2 === 0 ? "f1" : "f2")),
        { concurrency: "unbounded" },
      );

      const runningAfterRace = yield* store.read(
        `SELECT factory_id, id FROM operation WHERE status = 'running' ORDER BY factory_id`,
      );

      // A direct second running row is refused by the database itself.
      const forced = yield* Effect.exit(
        store.change(({ query, recordHistory }) =>
          Effect.gen(function* () {
            yield* query(`UPDATE operation SET status = 'running', started_at = 0 WHERE id = 2`);
            yield* recordHistory({ factoryId: "f1", kind: "probe", subject: "2" });
          }),
        ),
      );

      // Finishing the running one lets exactly the next queued entry in, oldest first.
      yield* store.change((change) => recordOperationResult(change, 1, { status: "complete", result: {} }));
      const next = yield* startNextOperation(store, "f1");

      return {
        admitted: admitted.filter((op) => op !== undefined).map((op) => [op.factoryId, op.id]),
        runningAfterRace,
        forced,
        next: next?.id,
        afterNext: yield* getOperation(store, 3),
      };
    }),
  );

  expect(result.admitted).toEqual([["f1", 1], ["f2", 5]]);
  expect(result.runningAfterRace).toEqual([{ factory_id: "f1", id: 1 }, { factory_id: "f2", id: 5 }]);
  expect(result.forced).toMatchObject(Exit.fail({ reason: "Sql" }));
  expect(result.next).toBe(2);
  expect(result.afterNext).toMatchObject({ status: "queued" });
});

test("an action that fails leaves its operation running, so the queue stays closed for recovery", async () => {
  const result = await withStore((store) =>
    Effect.gen(function* () {
      yield* enqueueOperation(store, integration("f1", 1));
      yield* enqueueOperation(store, integration("f1", 2));
      const started = yield* startNextOperation(store, "f1");
      const failed = yield* Effect.exit(runOperation(store, started!, () => Effect.fail("git died" as const)));

      return { failed, first: yield* getOperation(store, 1), next: yield* startNextOperation(store, "f1") };
    }),
  );

  expect(result.failed).toEqual(Exit.fail("git died"));
  expect(result.first).toMatchObject({ status: "running", result: null });
  expect(result.next).toBeUndefined();
});
