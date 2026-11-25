// Integration tier: a real disposable SQLite store drives the real per-factory recovery runner, the
// assignment watcher and the per-slot channel gate together (PRD §10.2 steps 3-5). The fault is an
// interrupted operation whose recovery is held open by the test, standing in for a stuck operation.
// Channel reconciliation itself is proved in message-delivery and resume-delivery tests; here the
// gate is driven directly, as `main.ts` does once a connection is reconciled and primed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import {
  beginOperation, createAssignmentScheduler, createChannelAssignmentGate, createTicketService, enqueueOperation,
  interruptRunningOperations, openStore, planSlots, recordRecoveryResultIn, startFactoryRecovery, startNextOperation,
  ticketFactoryFrom, watchAssignments,
} from "@foundry/daemon";
import type { PlannedSlot, QueuedTicket, Store } from "@foundry/daemon";
import { FactoryConfig } from "../src/config/schema.js";

const configOf = (name: string) => Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name, repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }] } },
});

const factories = ["shop", "other"].map((factoryId) => ({ factoryId, config: configOf(factoryId) }));

const slots = factories.flatMap(({ factoryId }) => planSlots(factoryId, [{
  address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 2, isolation: "none",
}]));

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const openFixtureStore = async (): Promise<Store> => {
  const root = mkdtempSync(join(tmpdir(), "foundry-startup-order-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(root, "foundry.db") })));

  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    for (const slot of slots) {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, ?, 'worker', ?, 'normal')`,
        [slot.factoryId, slot.slotId, slot.ordinal]);
    }

    yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
  })));

  const tickets = createTicketService({ store, stateRoot: root, factories: () => factories.map((f) => ticketFactoryFrom(f.config)) });

  for (const { factoryId } of factories) {
    await Effect.runPromise(tickets.submit({ factory: factoryId, title: `${factoryId} work`, spec: "Disposable spec" }));
  }

  return store;
};

/** Resolves with the assignments once any exists, re-read after every commit. */
interface AssignedRow {
  readonly factory_id: string;
  readonly slot_id: string;
  readonly ticket_number: number;
}

const whenAssigned = (store: Store) => new Promise<ReadonlyArray<AssignedRow>>((resolve) => {
  let done = false;

  const check = async () => {
    const rows = await Effect.runPromise(store.read<AssignedRow>(`SELECT factory_id, slot_id, ticket_number FROM assignment`));

    if (!done && rows.length > 0) {
      done = true;
      unsubscribe();
      resolve(rows);
    }
  };

  const unsubscribe = store.onCommit(() => { void check(); });
  void check();
});

test("startup reopens each queue only after its recovery, and assigns only to reconciled slots while another factory's operation is stuck", async () => {
  const store = await openFixtureStore();

  // Step 1: the daemon died with an operation running in shop, and a sync queued in each factory.
  const stuck = await Effect.runPromise(beginOperation(store, { factoryId: "shop", kind: "hook", intent: { hook: "fixture" } }));

  for (const { factoryId } of factories) {
    await Effect.runPromise(enqueueOperation(store, { factoryId, kind: "sync", intent: { defaultBranch: "main" } }));
  }

  expect(await Effect.runPromise(interruptRunningOperations(store))).toMatchObject([{ id: stuck.id, status: "interrupted" }]);

  const events: Array<string> = [];
  const errors: Array<unknown> = [];
  let otherResumed!: () => void;
  const otherDone = new Promise<void>((resolve) => { otherResumed = resolve; });
  let shopResumed!: () => void;
  const shopDone = new Promise<void>((resolve) => { shopResumed = resolve; });

  // Step 3: the steps settle at once, but shop's interrupted operation is recovered elsewhere (as
  // after_create is) and the test holds it, so shop's queue must keep waiting.
  const recovery = startFactoryRecovery({
    store, factories: factories.map((f) => f.factoryId),
    steps: [{ kind: "fixture", recover: async (factoryId) => { events.push(`steps ${factoryId}`); } }],
    onWaiting: (factoryId, awaiting) => events.push(`waiting ${factoryId} ${awaiting.map((o) => o.id).join(",")}`),
    onRecovered: async (factoryId) => {
      const admitted = await Effect.runPromise(startNextOperation(store, factoryId));
      events.push(`resumed ${factoryId} ${admitted?.kind ?? "nothing"}`);
      (factoryId === "shop" ? shopResumed : otherResumed)();
    },
    onError: (_factoryId, _kind, cause) => errors.push(cause),
  });

  cleanups.push(() => recovery.stop());

  // Steps 4-5: new work waits for each slot's own reconciled connection.
  const gate = createChannelAssignmentGate();

  const assignmentOptions = {
    store, factories, slots, configLoad: () => "load-1",
    ready: (_ticket: QueuedTicket, slot: PlannedSlot) => gate.isOpen(slot.factoryId, slot.slotId),
  };

  const stopAssignments = watchAssignments({ ...assignmentOptions, readinessChanged: gate.onOpened }, (error) => errors.push(error));
  cleanups.push(stopAssignments);

  await otherDone;
  // The unrelated factory's queue reopened; shop's stays closed while its operation awaits recovery.
  expect(events).toEqual(["steps shop", "steps other", "waiting shop " + String(stuck.id), "resumed other sync"]);
  expect(await Effect.runPromise(startNextOperation(store, "shop"))).toBeUndefined();

  // No connection is reconciled yet, and an accepted but unreconciled one is not enough: no early assignment.
  const shopWorker = gate.accepted({ factoryId: "shop", slotId: "worker/1" });
  // A direct `schedule()` runs the same pass the watcher runs on every commit, with the same `ready`
  // gate, so an empty result proves no pass could assign now rather than that the watcher hasn't run yet.
  expect(await Effect.runPromise(createAssignmentScheduler(assignmentOptions).schedule())).toEqual([]);
  expect(await Effect.runPromise(store.read(`SELECT id FROM assignment`))).toEqual([]);

  // Once its connection is reconciled, shop's worker takes work while shop's operation is still stuck.
  const assigned = whenAssigned(store);
  shopWorker.reconciled();
  expect(await assigned).toEqual([{ factory_id: "shop", slot_id: "worker/1", ticket_number: 1 }]);
  expect(events).not.toContain("resumed shop sync");

  // The stuck operation's verdict commits; only then does shop's queue reopen.
  await Effect.runPromise(store.change((change) => recordRecoveryResultIn(change, stuck.id, { status: "complete", result: { fixture: true } })));
  await shopDone;
  expect(events.at(-1)).toBe("resumed shop sync");
  expect(errors).toEqual([]);
});

test("a slot's gate follows only its current connection", () => {
  const gate = createChannelAssignmentGate();
  let opened = 0;
  gate.onOpened(() => { opened += 1; });
  const slot = { factoryId: "shop", slotId: "worker/1" };

  const first = gate.accepted(slot);
  const second = gate.accepted(slot);
  first.reconciled();
  expect(gate.isOpen("shop", "worker/1")).toBe(false);

  second.reconciled();
  first.closed();
  expect(gate.isOpen("shop", "worker/1")).toBe(true);
  expect(gate.isOpen("shop", "worker/2")).toBe(false);

  second.closed();
  expect(gate.isOpen("shop", "worker/1")).toBe(false);
  expect(opened).toBe(1);
});
