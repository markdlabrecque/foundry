// Integration tier: one real SQLite file per test, in a disposable temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit } from "effect";
import { foundryMigrations, openStore, type Migration, type Store } from "@foundry/daemon";

// Stands in for a later ticket's current-state table, one past the migrations this build knows.
const nextId = foundryMigrations.length + 1;
const withSlots: ReadonlyArray<Migration> = [
  ...foundryMigrations,
  {
    id: nextId,
    name: "test_slots",
    statements: [`CREATE TABLE slot (id TEXT PRIMARY KEY, factory_id TEXT NOT NULL, condition TEXT NOT NULL) STRICT`],
  },
];

// Unit: parallel branches each add a migration; a merge must renumber, never repeat or skip an ID.
test("the migrations this build ships are numbered 1..n with no gaps or repeats", () => {
  expect(foundryMigrations.map((m) => m.id)).toEqual(foundryMigrations.map((_, i) => i + 1));
});

let dir: string;
let filename: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foundry-store-"));
  filename = join(dir, "foundry.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const withStore = <A, E>(migrations: ReadonlyArray<Migration>, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename, migrations }), use)));

const openExit = (migrations: ReadonlyArray<Migration>) =>
  Effect.runPromiseExit(Effect.scoped(openStore({ filename, migrations })));

const snapshot = (store: Store) =>
  Effect.all({
    slots: store.read(`SELECT id, condition FROM slot ORDER BY id`),
    history: store.read(`SELECT sequence, factory_id, kind, subject, detail FROM history ORDER BY sequence`),
  });

const freeze = (store: Store, id: string) =>
  store.change(({ query, recordHistory }) =>
    Effect.gen(function* () {
      yield* query(`INSERT INTO slot (id, factory_id, condition) VALUES (?, 'f1', 'frozen')`, [id]);
      return yield* recordHistory({ factoryId: "f1", kind: "slot.frozen", subject: id, detail: { cause: "test" } });
    }),
  );

test("a committed change survives reopening the file in WAL mode", async () => {
  const sequence = await withStore(withSlots, (store) => freeze(store, "s1"));

  const reopened = await withStore(withSlots, (store) =>
    Effect.all({
      version: Effect.succeed(store.schemaVersion),
      journal: store.read<{ journal_mode: string }>(`PRAGMA journal_mode`),
      state: snapshot(store),
    }),
  );

  expect(reopened.version).toBe(nextId);
  expect(reopened.journal[0]?.journal_mode).toBe("wal");
  expect(reopened.state.slots).toEqual([{ id: "s1", condition: "frozen" }]);
  expect(reopened.state.history).toEqual([
    { sequence, factory_id: "f1", kind: "slot.frozen", subject: "s1", detail: '{"cause":"test"}' },
  ]);
});

test("opening a schema newer than this build knows is refused and leaves the file untouched", async () => {
  await withStore(withSlots, (store) => freeze(store, "s1"));

  const exit = await openExit(foundryMigrations);

  expect(exit).toMatchObject(Exit.fail({ reason: "NewerSchema" }));
  const after = await withStore(withSlots, snapshot);
  expect(after.slots).toEqual([{ id: "s1", condition: "frozen" }]);
  expect(after.history).toHaveLength(1);
});

test("an older database is migrated forward on open, keeping its history", async () => {
  await withStore(foundryMigrations, (store) =>
    store.change(({ recordHistory }) => recordHistory({ factoryId: "f1", kind: "run.started", subject: "r1" })),
  );

  const after = await withStore(withSlots, (store) =>
    Effect.all({ version: Effect.succeed(store.schemaVersion), state: snapshot(store) }),
  );

  expect(after.version).toBe(nextId);
  expect(after.state.slots).toEqual([]);
  expect(after.state.history).toMatchObject([{ kind: "run.started", subject: "r1" }]);
});

test("a failed change rolls back both its state writes and its history rows", async () => {
  const result = await withStore(withSlots, (store) =>
    Effect.gen(function* () {
      const failed = yield* Effect.exit(
        store.change(({ query, recordHistory }) =>
          Effect.gen(function* () {
            yield* query(`INSERT INTO slot (id, factory_id, condition) VALUES ('s1', 'f1', 'frozen')`);
            yield* recordHistory({ factoryId: "f1", kind: "slot.frozen", subject: "s1" });
            return yield* Effect.fail("boom" as const);
          }),
        ),
      );
      return { failed, state: yield* snapshot(store) };
    }),
  );

  expect(result.failed).toEqual(Exit.fail("boom"));
  expect(result.state).toEqual({ slots: [], history: [] });
});

test("a change that records no history is refused and rolled back", async () => {
  const result = await withStore(withSlots, (store) =>
    Effect.gen(function* () {
      const failed = yield* Effect.exit(
        store.change(({ query }) => query(`INSERT INTO slot (id, factory_id, condition) VALUES ('s1', 'f1', 'ok')`)),
      );
      return { failed, state: yield* snapshot(store) };
    }),
  );

  expect(result.failed).toMatchObject(Exit.fail({ reason: "NoHistory" }));
  expect(result.state).toEqual({ slots: [], history: [] });
});

test("migration IDs are unique and contiguous from 1", () => {
  expect(foundryMigrations.map((m) => m.id)).toEqual(foundryMigrations.map((_, i) => i + 1));
});

test("a commit listener that throws cannot turn a committed change into a failure", async () => {
  const result = await withStore(withSlots, (store) =>
    Effect.gen(function* () {
      store.onCommit(() => {
        throw new Error("listener bug");
      });
      const exit = yield* Effect.exit(freeze(store, "s1"));
      return { exit, state: yield* snapshot(store) };
    }),
  );

  expect(Exit.isSuccess(result.exit)).toBe(true);
  expect(result.state.slots).toEqual([{ id: "s1", condition: "frozen" }]);
  expect(result.state.history).toMatchObject([{ kind: "slot.frozen", subject: "s1" }]);
});

test("history rows cannot be updated or deleted", async () => {
  const outcomes = await withStore(withSlots, (store) =>
    Effect.gen(function* () {
      yield* freeze(store, "s1");
      const attempt = (statement: string) =>
        Effect.exit(
          store.change(({ query, recordHistory }) =>
            Effect.gen(function* () {
              yield* recordHistory({ factoryId: "f1", kind: "probe", subject: "s1" });
              yield* query(statement);
            }),
          ),
        );
      return {
        update: yield* attempt(`UPDATE history SET kind = 'x'`),
        remove: yield* attempt(`DELETE FROM history`),
        state: yield* snapshot(store),
      };
    }),
  );

  expect(outcomes.update).toMatchObject(Exit.fail({ reason: "Sql" }));
  expect(outcomes.remove).toMatchObject(Exit.fail({ reason: "Sql" }));
  expect(outcomes.state.history).toMatchObject([{ kind: "slot.frozen" }]);
});
