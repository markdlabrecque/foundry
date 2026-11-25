// Integration tier: real disposable SQLite proves capacity constraints and atomic durable context.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema } from "effect";
import {
  assignedSlot, assignmentTicket, createAssignmentScheduler, createTicketService,
  openStore, planSlots, StoreError, ticketFactoryFrom, watchAssignments,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { FactoryConfig } from "../src/config/schema.js";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", recovery_limit: 4,
  rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }, { id: "review", station: "floor.worker" }] } },
});

const slots = planSlots("shop", [{
  address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 2, isolation: "none",
}]);

const roots: Array<string> = [];

afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });

const fixture = async <A>(use: (store: Store, root: string) => Effect.Effect<A, StoreError>) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-assignments-"));
  roots.push(root);

  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(root, "foundry.db") });
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of slots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES ('shop', ?, 'worker', ?, 'normal')`, [slot.slotId, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });

    for (let n = 1; n <= 3; n++) {
      yield* tickets.submit({ title: `Ticket ${n}`, spec: `Spec ${n}` }).pipe(Effect.orDie);
    }

    return yield* use(store, root);
  })));
};

const options = (store: Store) => ({ store, slots, factories: [{ factoryId: "shop", config }], configLoad: () => "load-1" });

const snapshot = (store: Store) => Effect.all({
  tickets: store.read(`SELECT number, state, stage, status, messages_spent FROM ticket ORDER BY number`),
  assignments: store.read(`SELECT * FROM assignment ORDER BY created_at, ticket_number`),
  messages: store.read<{ body: string }>(`SELECT * FROM message ORDER BY sequence`),
  transitions: store.read(`SELECT * FROM ticket_transition ORDER BY sequence`),
  history: store.read(`SELECT * FROM history ORDER BY sequence`),
});

test("oldest first, one context per assignment across repeated and concurrent scans and restart", async () => {
  const saved = await fixture((store, root) => Effect.gen(function* () {
    // Submission timestamps, not ticket number, are authoritative. Put ticket 3 first.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE ticket SET submitted_at = number * 100 WHERE number != 3`);
      yield* change.query(`UPDATE ticket SET submitted_at = 0 WHERE number = 3`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "ordering" });
    }));
    const scheduler = createAssignmentScheduler(options(store));
    const scans = yield* Effect.all([scheduler.schedule(), scheduler.schedule()], { concurrency: "unbounded" });
    const assigned = scans.flat();
    expect(assigned.map((a) => [a.ticket, a.slotId])).toEqual([[3, "worker/1"], [1, "worker/2"]]);
    const before = yield* snapshot(store);
    expect(before.messages).toHaveLength(2);
    expect(before.transitions).toHaveLength(5); // submit plus exactly one assignment transition
    expect(before.messages).toMatchObject([
      { ticket_number: 3, recipient: "floor.worker", sender_slot: "", status: "unbound", delivery: "after_turn" },
      { ticket_number: 1 },
    ]);
    expect(before.messages[0]?.body).toContain("Specification:");
    expect(before.assignments).toMatchObject([
      { recovery_count: 0, recovery_ceiling: 4 }, { recovery_count: 0, recovery_ceiling: 4 },
    ]);
    expect(before.transitions[3]).toMatchObject({ actor: "daemon", from_state: "backlog", to_stage: "plan", to_status: "assigned", config_load: "load-1" });
    expect(yield* assignedSlot(store.read, "shop", 3)).toBe("worker/1");
    expect(yield* assignedSlot(store.read, "other", 3)).toBeNull();
    yield* Effect.all([scheduler.schedule(), scheduler.schedule()], { concurrency: "unbounded" });
    expect(yield* snapshot(store)).toEqual(before);
    // A new scheduler has no in-memory dedup state.
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(before);

    return { root, before };
  }));

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename: join(saved.root, "foundry.db") });
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    expect(yield* snapshot(store)).toEqual(saved.before);
  })));
});

test("queued stages, frozen/parked slots and lifecycle/readiness gates are respected", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = CASE ordinal WHEN 1 THEN 'frozen' ELSE 'parked' END`);
      yield* change.query(`UPDATE ticket SET state = 'stage', stage = 'review', status = 'queued' WHERE number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "conditions" });
    }));
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toEqual([]);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET condition = 'normal' WHERE ordinal = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "unpark" });
    }));
    expect(yield* createAssignmentScheduler({ ...options(store), inScope: () => false }).schedule()).toEqual([]);
    expect(yield* createAssignmentScheduler({ ...options(store), ready: () => false }).schedule()).toEqual([]);
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toMatchObject([{ ticket: 1, stage: "review", slotId: "worker/2" }]);
    yield* store.change((change) => Effect.gen(function* () {
      expect(yield* assignmentTicket(change, "shop", "worker/2")).toBe(1);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "lookup" });
    }));
  }));
});

test("failure after all assignment effects rolls back ticket, transition, assignment, context and history", async () => {
  await fixture((store) => Effect.gen(function* () {
    const before = yield* snapshot(store);

    const failing: Store = { ...store, change: (body) => store.change((change) =>
      Effect.flatMap(body(change), () => Effect.fail(new StoreError({ reason: "Sql", message: "commit failure" })))),
    };

    const exit = yield* Effect.exit(createAssignmentScheduler(options(failing)).schedule());
    expect(exit).toMatchObject(Exit.fail({ reason: "Sql" }));
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* createAssignmentScheduler(options(store)).schedule()).toHaveLength(2);
  }));
});

test("commit wakeups assign startup backlog and newly freed capacity; stopping removes the watcher", async () => {
  await fixture((store) => Effect.gen(function* () {
    // Synchronize on actual commits, not sleeps or polling.
    let nextCommit: (() => void) | undefined;
    const unsubscribe = store.onCommit(() => nextCommit?.());
    const committed = () => new Promise<void>((resolve) => { nextCommit = resolve; });
    const errors: Array<Error> = [];
    const first = committed();
    const stop = watchAssignments(options(store), (error) => errors.push(error));
    yield* Effect.promise(() => first);
    expect(yield* store.read(`SELECT ticket_number FROM assignment ORDER BY ticket_number`)).toEqual([
      { ticket_number: 1 }, { ticket_number: 2 },
    ]);
    // Release capacity, as a separate outcome transaction would. Ticket 3 must be picked up.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 1 WHERE ticket_number = 1`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "freed" });
    }));
    const next = committed();
    yield* Effect.promise(() => next);
    yield* Effect.promise(stop);
    unsubscribe();
    expect(errors).toEqual([]);
    expect(yield* assignedSlot(store.read, "shop", 3)).toBe("worker/1");
    const before = yield* snapshot(store);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = 2 WHERE ticket_number = 2`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "after-stop" });
    }));
    expect((yield* snapshot(store)).messages).toEqual(before.messages);
  }));
});

test("database rejects a second unended assignment per ticket and a second active assignment per slot", async () => {
  await fixture((store) => Effect.gen(function* () {
    yield* createAssignmentScheduler(options(store)).schedule();
    const before = yield* snapshot(store);

    for (const [ticket, status] of [[1, "suspended"], [3, "active"]] as const) {
      const exit = yield* Effect.exit(store.change((change) => Effect.gen(function* () {
        yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
          SELECT 'duplicate', 'shop', ?, 'plan', 'worker/1', ?, 4, 0, id FROM message LIMIT 1`, [ticket, status]);
        yield* change.recordHistory({ factoryId: "shop", kind: "probe", subject: "duplicate" });
      })));

      expect(exit).toMatchObject(Exit.fail({ reason: "Sql" }));
    }

    expect(yield* snapshot(store)).toEqual(before);
  }));
});
