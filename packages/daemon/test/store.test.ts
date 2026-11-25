// Integration tier: one real SQLite file per test, in a disposable temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit } from "effect";
import { acceptMessage, bindStationMessages, foundryMigrations, openStore, startMessageRouting, StoreError } from "@foundry/daemon";
import type { Change, Migration, PlannedSlot, Store } from "@foundry/daemon";

// Stands in for a later ticket's current-state table, one past the migrations this build knows.
const nextId = foundryMigrations.length + 1;

const withSlots: ReadonlyArray<Migration> = [
  ...foundryMigrations,
  {
    id: nextId,
    name: "test_slots",
    statements: [`CREATE TABLE probe_slot (id TEXT PRIMARY KEY, factory_id TEXT NOT NULL, condition TEXT NOT NULL) STRICT`],
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
    slots: store.read(`SELECT id, condition FROM probe_slot ORDER BY id`),
    history: store.read(`SELECT sequence, factory_id, kind, subject, detail FROM history ORDER BY sequence`),
  });

const freeze = (store: Store, id: string) =>
  store.change(({ query, recordHistory }) =>
    Effect.gen(function* () {
      yield* query(`INSERT INTO probe_slot (id, factory_id, condition) VALUES (?, 'f1', 'frozen')`, [id]);

      return yield* recordHistory({ factoryId: "f1", kind: "slot.frozen", subject: id, detail: { cause: "test" } });
    }),
  );

test("request abandonment migration preserves populated request records and their message foreign keys", async () => {
  const beforeAbandonment = foundryMigrations.filter((migration) => migration.id < 22);

  const original = await withStore(beforeAbandonment, (store) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      const notice = yield* acceptMessage(change, { factoryId: "f1", senderSlot: "worker/1", recipient: "floor.helper",
        body: "Keep this question", delivery: "after_turn", kind: "request_notice", correlation: { requestId: "request-1", ticket: 1 } });

      yield* change.query(`INSERT INTO agent_request (id, factory_id, requester_slot, recipient, recipient_slot,
        ticket_number, notice_id, status, accepted_at, deadline) VALUES ('request-1', 'f1', 'worker/1', 'floor.helper',
        'helper/1', 1, ?, 'open', 1, 100)`, [notice.id]);
    }));

    return yield* store.read(`SELECT * FROM agent_request`);
  }));

  await withStore(foundryMigrations, (store) => Effect.gen(function* () {
    expect(yield* store.read(`SELECT * FROM agent_request`)).toEqual(original);
    expect(yield* store.read(`PRAGMA foreign_key_check`)).toEqual([]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE agent_request SET status = 'abandoned' WHERE id = 'request-1'`);
      yield* change.recordHistory({ factoryId: "f1", kind: "request.abandoned", subject: "request-1" });
    }));
    expect(yield* store.read(`SELECT status FROM agent_request`)).toEqual([{ status: "abandoned" }]);
  }));
});

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
            yield* query(`INSERT INTO probe_slot (id, factory_id, condition) VALUES ('s1', 'f1', 'frozen')`);
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
        store.change(({ query }) => query(`INSERT INTO probe_slot (id, factory_id, condition) VALUES ('s1', 'f1', 'ok')`)),
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

const routingSlots: ReadonlyArray<PlannedSlot> = [1, 2].map((ordinal) => ({
  factoryId: "alpha", slotId: `builder/${ordinal}`, ordinal,
  station: { address: "eng.builder", room: "eng", station: "builder", instructions: [], model: "faux/scripted",
    skills: [], extensions: [], instances: 2, isolation: "none" },
}));

const acceptRoutingMessage = (store: Store, ticket: number | null = null, recipient = "eng.builder") =>
  store.change((change) => acceptMessage(change, {
    factoryId: "alpha", senderSlot: "sender/1", recipient, body: "route me", kind: "ordinary", delivery: "after_turn",
    correlation: { ticket },
  }));

test("message acceptance schema upgrades without losing queued work", async () => {
  // A historical schema fixture uses historical columns, not today's acceptance implementation.
  await withStore(foundryMigrations.filter((m) => m.id <= 12), (store) => store.change((change) => Effect.gen(function* () {
    yield* change.query(`INSERT INTO message (id, factory_id, sequence, sender_slot, recipient, body, delivery, kind, status, accepted_at)
      VALUES ('queued-before-binding', 'alpha', 1, 'sender/1', 'eng.builder', 'route me', 'after_turn', 'ordinary', 'unbound', 1)`);
    yield* change.recordHistory({ factoryId: "alpha", kind: "message.accepted", subject: "queued-before-binding" });
  })));
  await withStore(foundryMigrations, (store) => Effect.gen(function* () {
    expect(yield* store.read(`SELECT id, status, bound_slot, bound_at FROM message`)).toEqual([
      { id: "queued-before-binding", status: "unbound", bound_slot: null, bound_at: null },
    ]);
  }));
});

test("commit-driven routing wakes on eligibility changes and stops cleanly", async () => {
  await withStore(foundryMigrations, (store) => Effect.promise(async () => {
    const message = await Effect.runPromise(acceptRoutingMessage(store));
    const errors: Array<unknown> = [];
    let observed: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => { observed = resolve; });

    const unsubscribe = store.onCommit(() => {
      void Effect.runPromise(store.read<{ status: string }>(`SELECT status FROM message WHERE id = ?`, [message.id]))
        .then((rows) => { if (rows[0]?.status === "bound") {observed?.();} });
    });

    const stop = startMessageRouting({ store, slots: routingSlots, onError: (cause) => { errors.push(cause); } });

    try {
      await Effect.runPromise(store.change((change) => Effect.gen(function* () {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('alpha', 'builder/1', 'eng.builder', 1, 'normal')`);
        yield* change.recordHistory({ factoryId: "alpha", kind: "test.eligible", subject: "builder/1" });
      })));
      await committed;
      await stop();
      expect(errors).toEqual([]);
      expect(await Effect.runPromise(store.read(`SELECT status, bound_slot FROM message`))).toEqual([{ status: "bound", bound_slot: "builder/1" }]);
      await Effect.runPromise(acceptRoutingMessage(store));
      expect(await Effect.runPromise(store.read(`SELECT status FROM message ORDER BY sequence`))).toEqual([{ status: "bound" }, { status: "unbound" }]);
    } finally {
      unsubscribe();
      await stop();
    }
  }));
});

const routingState = (store: Store) => Effect.all({
  messages: store.read(`SELECT id, sequence, status, bound_slot, bound_at FROM message ORDER BY sequence`),
  history: store.read<{ subject: string; detail: string }>(`SELECT subject, detail FROM history WHERE kind = 'message.bound' ORDER BY sequence`),
});

test("routing commits in acceptance order, leaves ineligible work unbound and never rebinds across reopen/replacement", async () => {
  const accepted = await withStore(foundryMigrations, (store) => Effect.gen(function* () {
    const first = yield* acceptRoutingMessage(store, 42);
    const second = yield* acceptRoutingMessage(store);
    const waiting = yield* acceptRoutingMessage(store, null, "ops.deployer");
    // No persisted eligible slots yet: no made-up binding or history row.
    expect(yield* bindStationMessages({ store, slots: routingSlots })).toEqual([]);
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of routingSlots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition, current_launch)
          VALUES ('alpha', ?, 'eng.builder', ?, 'normal', 'old-launch')`, [slot.slotId, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "alpha", kind: "test.slots", subject: "slots" });
    }));

    const options = { store, slots: routingSlots, assignedSlot: (_change: Change, factory: string, ticket: number) => {
      expect([factory, ticket]).toEqual(["alpha", 42]);

      return Effect.succeed("builder/2");
    } };

    const passes = yield* Effect.all([bindStationMessages(options), bindStationMessages(options)], { concurrency: 2 });
    expect(passes.flat()).toEqual([
      { id: first.id, factoryId: "alpha", sequence: 1, slotId: "builder/2" },
      { id: second.id, factoryId: "alpha", sequence: 2, slotId: "builder/1" },
    ]);
    const state = yield* routingState(store);
    expect(state.messages).toMatchObject([
      { id: first.id, status: "bound", bound_slot: "builder/2", bound_at: expect.any(Number) },
      { id: second.id, status: "bound", bound_slot: "builder/1", bound_at: expect.any(Number) },
      { id: waiting.id, status: "unbound", bound_slot: null, bound_at: null },
    ]);
    expect(state.history.map((row) => row.subject)).toEqual([first.id, second.id]);

    return state;
  }));

  await withStore(foundryMigrations, (store) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET current_launch = 'replacement', condition = 'frozen'`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "test.replacement", subject: "slots" });
    }));
    expect(yield* bindStationMessages({ store, slots: routingSlots, assignedSlot: () => Effect.succeed("builder/1") })).toEqual([]);
    expect(yield* routingState(store)).toEqual(accepted);

    const mutation = yield* Effect.exit(store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET bound_slot = 'builder/1' WHERE sequence = 1`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "test.rebind", subject: "message" });
    })));

    expect(mutation).toMatchObject(Exit.fail({ reason: "Sql" }));
    expect(yield* routingState(store)).toEqual(accepted);
  }));
});

test("binding rolls back the whole pass on lookup failure and respects factory scope and slot condition", async () => {
  await withStore(foundryMigrations, (store) => Effect.gen(function* () {
    yield* acceptRoutingMessage(store);
    yield* acceptRoutingMessage(store, 42);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('alpha', 'builder/1', 'eng.builder', 1, 'parked')`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "test.slot", subject: "builder/1" });
    }));
    const options = { store, slots: routingSlots };
    expect(yield* bindStationMessages(options)).toEqual([]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'normal'`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "test.unpark", subject: "builder/1" });
    }));
    expect(yield* bindStationMessages({ ...options, inScope: () => false })).toEqual([]);
    const before = yield* routingState(store);

    const failed = yield* Effect.exit(bindStationMessages({ ...options,
      assignedSlot: () => Effect.fail(new StoreError({ reason: "Sql", message: "lookup failed" })),
    }));

    expect(failed).toMatchObject(Exit.fail({ reason: "Sql" }));
    expect(yield* routingState(store)).toEqual(before);
    expect(yield* bindStationMessages(options)).toHaveLength(2);
  }));
});
