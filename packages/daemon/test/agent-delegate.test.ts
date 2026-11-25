// Integration tier: disposable real SQLite proves scope, atomic acceptance, routing and replay.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import {
  agentDelegateHandler, bindStationMessages, createAssignmentScheduler, createSubmissions,
  createTicketService, openStore, planSlots, ticketFactoryFrom, ToolRefusal,
} from "@foundry/daemon";
import type { Store, ToolHandler } from "@foundry/daemon";
import { AGENT_DELEGATE } from "@foundry/protocol";
import { FactoryConfig } from "../src/config/schema.js";

const dirs: Array<string> = [];

afterEach(async () => { for (const dir of dirs.splice(0)) {await rm(dir, { recursive: true, force: true });} });

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard",
  rooms: { floor: { stations: { worker: {}, reviewer: {} } } },
  production_lines: { standard: { stages: [{ id: "build", station: "floor.worker" }] } },
});

const slots = planSlots("shop", ["worker", "reviewer"].map((station) => ({
  address: `floor.${station}`, room: "floor", station, model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 2, isolation: "none" as const,
})));

const sender = { factoryId: "shop", slotId: "worker/1", launchId: "launch-1" };
const args = { recipient: "floor.reviewer", body: "Review this ticket", rootAssignment: "forged", depth: 99, ticket: 99 };

const withStore = <A, E>(filename: string, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename }), use)));

const dispatcher = (store: Store, handler: ToolHandler = agentDelegateHandler([...slots, ...slots.map((slot) => ({ ...slot, factoryId: "other" }))])) =>
  createSubmissions({ store, handlers: new Map([[AGENT_DELEGATE, handler]]) });

const submit = (store: Store, callId: string, input: Schema.Json = args, slot = sender, handler?: ToolHandler) =>
  dispatcher(store, handler).submit(slot, { type: "tool_call", callId, tool: AGENT_DELEGATE, args: input });

const failing: ToolHandler = (change, call) => Effect.gen(function* () {
  yield* agentDelegateHandler(slots)(change, call);

  return yield* new ToolRefusal({ code: "injected", detail: "fail after all writes" });
});

const snapshot = (store: Store) => Effect.all({
  delegations: store.read<{ id: string; root_assignment: string; depth: number; notice_id: string }>(`SELECT * FROM delegation ORDER BY accepted_at, rowid`),
  messages: store.read(`SELECT * FROM message ORDER BY sequence`),
  tickets: store.read(`SELECT * FROM ticket`),
  submissions: store.read(`SELECT * FROM submission`),
  history: store.read<{ kind: string }>(`SELECT * FROM history ORDER BY sequence`),
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "foundry-delegate-"));
  dirs.push(root);
  const filename = join(root, "foundry.db");
  await withStore(filename, (store) => Effect.gen(function* () {
    yield* store.change((change) => Effect.gen(function* () {
      for (const slot of slots) {
        yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, ?, ?, ?, 'normal')`,
          [slot.factoryId, slot.slotId, slot.station.address, slot.ordinal]);
      }

      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slots" });
    }));
    const tickets = createTicketService({ store, stateRoot: root, factories: () => [ticketFactoryFrom(config)] });
    yield* tickets.submit({ title: "Disposable ticket", spec: "Spec" }).pipe(Effect.orDie);
    yield* createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config }] }).schedule();
  }));

  return filename;
};

test("one durable obligation and notice per submission, root identity is authoritative and replay survives reopen", async () => {
  const filename = await fixture();

  const saved = await withStore(filename, (store) => Effect.gen(function* () {
    const before = yield* snapshot(store);
    const outcomes = yield* Effect.promise(() => Promise.all([submit(store, "one"), submit(store, "one")]));
    expect(outcomes[0]).toMatchObject({ status: "committed", value: { depth: 1, parentDelegationId: null } });
    expect(outcomes[1]).toEqual(outcomes[0]);
    const after = yield* snapshot(store);
    expect(after.tickets).toEqual(before.tickets);
    expect(after.delegations).toHaveLength(1);
    expect(after.messages).toHaveLength(before.messages.length + 1);
    const obligation = after.delegations[0];
    expect(after.messages.at(-1)).toMatchObject({ id: obligation?.notice_id, delegation_id: obligation?.id,
      ticket_number: 1, kind: "delegation_notice", status: "unbound", recipient: "floor.reviewer" });
    expect(after.submissions).toHaveLength(1);
    expect(after.history.filter((row) => row.kind === "delegation.accepted")).toHaveLength(1);

    return { outcome: outcomes[0], after };
  }));

  await withStore(filename, (store) => Effect.gen(function* () {
    expect(yield* Effect.promise(() => submit(store, "one", {}))).toEqual(saved.outcome);
    expect(yield* snapshot(store)).toEqual(saved.after);
  }));
});

test("parent requires the same factory, selected slot, open state and active root; children inherit root and depth", async () => {
  const filename = await fixture();
  await withStore(filename, (store) => Effect.gen(function* () {
    yield* Effect.promise(() => submit(store, "root"));
    const parent = (yield* snapshot(store)).delegations[0];
    const childArgs = { recipient: "floor.worker", body: "Investigate", parentDelegationId: parent?.id ?? "missing-parent" };
    const recipient = { ...sender, slotId: "reviewer/1" };

    const refuse = (id: string, input: Schema.Json = childArgs, slot = recipient) => Effect.promise(async () => {
      const before = await Effect.runPromise(snapshot(store));
      expect(await submit(store, id, input, slot)).toMatchObject({ status: "refused", code: "delegation_scope" });
      expect(await Effect.runPromise(snapshot(store))).toEqual(before);
    });

    yield* refuse("unselected");
    yield* bindStationMessages({ store, slots });
    expect(yield* store.read(`SELECT d.recipient_slot, m.bound_slot FROM delegation d JOIN message m ON m.id = d.notice_id`))
      .toEqual([{ recipient_slot: "reviewer/1", bound_slot: "reviewer/1" }]);
    expect(yield* bindStationMessages({ store, slots })).toEqual([]);
    yield* refuse("wrong-slot", childArgs, { ...recipient, slotId: "reviewer/2" });
    yield* refuse("foreign", childArgs, { ...recipient, factoryId: "other" });
    yield* refuse("missing", { ...childArgs, parentDelegationId: "missing" });
    expect(yield* Effect.promise(() => submit(store, "child", childArgs, recipient))).toMatchObject({
      status: "committed", value: { rootAssignment: parent?.root_assignment, parentDelegationId: parent?.id, depth: 2 },
    });
    const child = (yield* snapshot(store)).delegations[1];
    yield* bindStationMessages({ store, slots });
    expect(yield* Effect.promise(() => submit(store, "grandchild", {
      ...args, parentDelegationId: child?.id ?? "missing-child",
    }))).toMatchObject({ status: "committed", value: { rootAssignment: parent?.root_assignment, depth: 3 } });
    expect((yield* snapshot(store)).delegations).toHaveLength(3);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = 'completed' WHERE id = ?`, [parent?.id ?? ""]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "closed" });
    }));
    yield* refuse("closed");
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = 'open'`);
      yield* change.query(`UPDATE assignment SET status = 'suspended'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "suspended" });
    }));
    yield* refuse("suspended-child");
    yield* refuse("suspended-root", { recipient: "floor.worker", body: "No active root" }, sender);
  }));
});

test("validation and transaction failures retain neither obligation, notice, submission nor history", async () => {
  const filename = await fixture();
  await withStore(filename, (store) => Effect.gen(function* () {
    const before = yield* snapshot(store);

    for (const input of [{}, { ...args, delivery: "now" }, { ...args, recipient: "other.station" }]) {
      expect(yield* Effect.promise(() => submit(store, "invalid", input))).toMatchObject({ status: "refused" });
      expect(yield* snapshot(store)).toEqual(before);
    }

    expect(yield* Effect.promise(() => submit(store, "retry", args, sender, failing))).toMatchObject({ status: "refused", code: "injected" });
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* Effect.promise(() => submit(store, "retry"))).toMatchObject({ status: "committed" });
    expect((yield* snapshot(store)).delegations).toHaveLength(1);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`CREATE TRIGGER fail_delegation BEFORE INSERT ON delegation BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "SQL fault" });
    }));
    const beforeSql = yield* snapshot(store);
    expect(yield* Effect.promise(() => submit(store, "sql-fault"))).toMatchObject({ status: "refused", code: "not_committed" });
    expect(yield* snapshot(store)).toEqual(beforeSql);
  }));
});
