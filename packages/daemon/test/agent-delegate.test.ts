// Integration tier: disposable real SQLite proves scope, atomic acceptance, routing and replay.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import {
  acknowledgeMessage, agentDelegateHandler, agentReplyHandler, bindStationMessages, createAssignmentScheduler, createMessageDisposition, createSubmissions,
  createTicketService, openStore, planSlots, raiseHoldIn, taskTransitionHandler, ticketFactoryFrom, ToolRefusal,
} from "@foundry/daemon";
import type { Store, ToolHandler } from "@foundry/daemon";
import { AGENT_DELEGATE, AGENT_REPLY, TASK_TRANSITION } from "@foundry/protocol";
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
    const beforeLimit = yield* snapshot(store);
    expect(yield* Effect.promise(() => submit(store, "grandchild", {
      ...args, parentDelegationId: child?.id ?? "missing-child",
    }))).toMatchObject({ status: "refused", code: "delegation_depth_limit" });
    expect(yield* snapshot(store)).toEqual(beforeLimit);
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

const responder = { ...sender, slotId: "reviewer/1", launchId: "replacement-reviewer" };
const resolution = { outcome: "reviewed", evidence: "All acceptance checks pass" };

const replies = (store: Store, handler = agentReplyHandler()) =>
  createSubmissions({ store, handlers: new Map([[AGENT_REPLY, handler]]) });

const selectedDelegation = (store: Store) => Effect.gen(function* () {
  yield* Effect.promise(() => submit(store, "delegate"));
  yield* bindStationMessages({ store, slots });
  const delegation = (yield* snapshot(store)).delegations[0];

  if (delegation === undefined) {throw new Error("delegation missing");}

  return delegation;
});

test("acknowledgement leaves the obligation open; only its selected slot can resolve it with outcome and evidence", async () => {
  const filename = await fixture();

  const saved = await withStore(filename, (store) => Effect.gen(function* () {
    const delegation = yield* selectedDelegation(store);
    // A real receipt for a durable sent attempt must not resolve the obligation.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET status = 'sent' WHERE id = ?`, [delegation.notice_id]);
      yield* change.query(`INSERT INTO message_attempt (id, factory_id, message_id, slot_id, launch_id, connection_id, sent_at)
        VALUES ('attempt', 'shop', ?, 'reviewer/1', 'replacement-reviewer', 'connection', 1)`, [delegation.notice_id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "attempt" });
    }));
    expect(yield* acknowledgeMessage(store, responder, delegation.notice_id)).toBe(true);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "open" }]);
    const before = yield* snapshot(store);

    const frame = { type: "tool_call", callId: "resolve", tool: AGENT_REPLY,
      args: { delegationId: delegation.id, ...resolution, delegatingSlot: "spoof", ticket: 999 } } as const;

    for (const identity of [sender, { ...responder, slotId: "reviewer/2" }, { ...responder, factoryId: "other" }]) {
      expect(yield* Effect.promise(() => replies(store).submit(identity, frame))).toMatchObject({ status: "refused" });
      expect(yield* snapshot(store)).toEqual(before);
    }

    for (const input of [{ delegationId: delegation.id }, { ...frame.args, evidence: "" },
      { ...frame.args, outcome: "" }, { ...frame.args, requestId: "ambiguous" }]) {
      expect(yield* Effect.promise(() => replies(store).submit(responder, { ...frame, args: input })))
        .toMatchObject({ status: "refused", code: "invalid_arguments" });
      expect(yield* snapshot(store)).toEqual(before);
    }

    const outcome = yield* Effect.promise(() => replies(store).submit(responder, frame));
    expect(outcome).toMatchObject({ status: "committed", value: { delegationId: delegation.id, status: "completed" } });
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "completed" }]);
    expect(yield* store.read(`SELECT kind, delegation_id, request_id, ticket_number, recipient, bound_slot, status, body FROM message WHERE kind = 'reply'`))
      .toEqual([{ kind: "reply", delegation_id: delegation.id, request_id: null, ticket_number: 1,
        recipient: sender.slotId, bound_slot: sender.slotId, status: "bound", body: JSON.stringify(resolution) }]);
    expect(yield* store.read(`SELECT detail FROM history WHERE kind = 'delegation.completed'`))
      .toEqual([{ detail: expect.stringContaining(resolution.evidence) }]);
    const completed = yield* snapshot(store);
    expect(yield* Effect.promise(() => replies(store).submit({ ...responder, launchId: "next-launch" }, { ...frame, callId: "duplicate" })))
      .toMatchObject({ status: "refused", code: "delegation_closed" });
    expect(yield* snapshot(store)).toEqual(completed);

    return { frame, outcome, completed };
  }));

  await withStore(filename, (store) => Effect.gen(function* () {
    expect(yield* Effect.promise(() => replies(store).submit(responder, saved.frame))).toEqual(saved.outcome);
    expect(yield* snapshot(store)).toEqual(saved.completed);
    expect(yield* bindStationMessages({ store, slots })).toEqual([]);
  }));
});

test("unselected and closed delegations cannot resolve; competing resolutions commit just one result", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    yield* Effect.promise(() => submit(store, "delegate"));
    const delegation = (yield* snapshot(store)).delegations[0];

    const frame = { type: "tool_call", callId: "resolve", tool: AGENT_REPLY,
      args: { delegationId: delegation?.id ?? "missing", ...resolution } } as const;

    expect(yield* Effect.promise(() => replies(store).submit(responder, frame))).toMatchObject({ status: "refused", code: "wrong_recipient" });
    yield* bindStationMessages({ store, slots });

    for (const status of ["abandoned", "cancelled"]) {
      yield* store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE delegation SET status = ?`, [status]);
        yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: status });
      }));
      const before = yield* snapshot(store);
      expect(yield* Effect.promise(() => replies(store).submit(responder, frame))).toMatchObject({ status: "refused", code: "delegation_closed" });
      expect(yield* snapshot(store)).toEqual(before);
    }

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = 'open'`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "reopen" });
    }));
    const outcomes = yield* Effect.promise(() => Promise.all(["one", "two"].map((callId) => replies(store).submit(responder, { ...frame, callId }))));
    expect(outcomes.filter((outcome) => outcome.status === "committed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "refused")).toMatchObject([{ code: "delegation_closed" }]);
    expect(yield* store.read(`SELECT id FROM message WHERE kind = 'reply'`)).toHaveLength(1);
    expect(yield* store.read(`SELECT sequence FROM history WHERE kind = 'delegation.completed'`)).toHaveLength(1);
  }));
});

const holdNotice = (store: Store, noticeId: string) => store.change((change) => Effect.gen(function* () {
  yield* change.query(`UPDATE message SET status = 'indeterminate' WHERE id = ?`, [noticeId]);
  yield* raiseHoldIn(change, { factoryId: "shop", kind: "indeterminate_message", subject: noticeId, evidence: {} });
}));

const holdStates = (store: Store) => store.read(`SELECT state FROM operator_hold`);

test("dropping an indeterminate delegation notice abandons the delegation and durably tells the delegating slot once", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const delegation = yield* selectedDelegation(store);
    yield* holdNotice(store, delegation.notice_id);
    const disposition = createMessageDisposition(store);
    yield* disposition.act(delegation.notice_id, "drop", true);
    const dropped = yield* snapshot(store);

    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "abandoned" }]);
    expect(yield* store.read(`SELECT status FROM message WHERE id = ?`, [delegation.notice_id])).toEqual([{ status: "dropped" }]);
    expect(yield* store.read(`SELECT sender_kind, kind, ticket_number, bound_slot, status FROM message
      WHERE delegation_id = ? AND id != ?`, [delegation.id, delegation.notice_id])).toEqual([{ sender_kind: "daemon",
      kind: "ordinary", ticket_number: 1, bound_slot: sender.slotId, status: "bound" }]);
    expect(dropped.history.filter((row) => row.kind === "delegation.abandoned")).toHaveLength(1);

    // A repeated drop is refused and leaves the single notification as the only one.
    const again = yield* Effect.flip(disposition.act(delegation.notice_id, "drop", true));
    expect(again).toMatchObject({ code: "not_indeterminate" });
    expect(yield* snapshot(store)).toEqual(dropped);
  }));
});

test("a drop that fails while abandoning leaves the notice, hold, delegation and history unwritten", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const delegation = yield* selectedDelegation(store);
    yield* holdNotice(store, delegation.notice_id);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`CREATE TRIGGER refuse_abandon BEFORE INSERT ON history WHEN NEW.kind = 'delegation.abandoned'
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture.trigger", subject: delegation.id });
    }));
    const armed = yield* snapshot(store);

    yield* Effect.promise(() => expect(Effect.runPromise(createMessageDisposition(store).act(delegation.notice_id, "drop", true)))
      .rejects.toThrow(/fixture failure/));

    expect(yield* snapshot(store)).toEqual(armed);
    expect(yield* store.read(`SELECT status FROM message WHERE id = ?`, [delegation.notice_id])).toEqual([{ status: "indeterminate" }]);
    expect(yield* holdStates(store)).toEqual([{ state: "open" }]);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "open" }]);
    expect(yield* store.read(`SELECT id FROM message WHERE sender_kind = 'daemon' AND delegation_id = ?`, [delegation.id])).toEqual([]);
  }));
});

test("dropping the notice of an already completed delegation keeps its result and notifies nobody", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const delegation = yield* selectedDelegation(store);
    expect(yield* Effect.promise(() => replies(store).submit(responder, { type: "tool_call", callId: "resolve", tool: AGENT_REPLY,
      args: { delegationId: delegation.id, ...resolution } }))).toMatchObject({ status: "committed" });
    yield* holdNotice(store, delegation.notice_id);

    yield* createMessageDisposition(store).act(delegation.notice_id, "drop", true);

    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "completed" }]);
    expect(yield* store.read(`SELECT id FROM message WHERE sender_kind = 'daemon' AND delegation_id = ?`, [delegation.id])).toEqual([]);
    const history = (yield* snapshot(store)).history;
    expect(history.filter((row) => row.kind === "message.dropped")).toHaveLength(1);
    expect(history.filter((row) => row.kind === "delegation.abandoned")).toEqual([]);
    expect(yield* holdStates(store)).toEqual([{ state: "resolved" }]);
  }));
});

const failReply: ToolHandler = (change, call) => Effect.gen(function* () {
  yield* agentReplyHandler()(change, call);
  yield* change.query(`INSERT INTO nonexistent_table VALUES (1)`);

  return null;
});

test("a failed resolution rolls back result, obligation state, history and submission together", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const delegation = yield* selectedDelegation(store);
    const before = yield* snapshot(store);

    const frame = { type: "tool_call", callId: "retry", tool: AGENT_REPLY, args: { delegationId: delegation.id, ...resolution } } as const;
    expect(yield* Effect.promise(() => replies(store, failReply).submit(responder, frame))).toMatchObject({ status: "refused", code: "not_committed" });
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* Effect.promise(() => replies(store).submit(responder, frame))).toMatchObject({ status: "committed" });
  }));
});

test.each([0, 1, 3])("configured depth %i accepts exactly the limit and refuses one beyond without writes", async (limit) => {
  const filename = await fixture();
  await withStore(filename, (store) => Effect.gen(function* () {
    const handler = agentDelegateHandler(slots, {
      delegationDepthLimit: (factoryId) => factoryId === "shop" ? limit : 99,
      budget: () => Effect.die("depth refusal must precede notice acceptance"),
    });

    const accepting = agentDelegateHandler(slots, {
      delegationDepthLimit: (factoryId) => factoryId === "shop" ? limit : 99,
    });

    let parentDelegationId: string | undefined;
    let slot = sender;

    for (let depth = 1; depth <= limit; depth++) {
      const recipient = depth % 2 === 1 ? "floor.reviewer" : "floor.worker";

      const input = parentDelegationId === undefined
        ? { ...args, recipient }
        : { ...args, recipient, parentDelegationId };

      expect(yield* Effect.promise(() => submit(store, `depth-${depth}`, input, slot, accepting)))
        .toMatchObject({ status: "committed", value: { depth } });
      parentDelegationId = (yield* snapshot(store)).delegations.at(-1)?.id;
      yield* bindStationMessages({ store, slots });
      slot = { ...sender, slotId: depth % 2 === 1 ? "reviewer/1" : "worker/1" };
    }

    expect((yield* snapshot(store)).delegations).toHaveLength(limit);
    const before = yield* snapshot(store);
    const forged = { ...args, depth: 0, delegation_depth_limit: 99 };
    const input = parentDelegationId === undefined ? forged : { ...forged, parentDelegationId };

    expect(yield* Effect.promise(() => submit(store, "beyond", input, slot, handler)))
      .toMatchObject({ status: "refused", code: "delegation_depth_limit", detail: `delegation depth ${limit + 1} exceeds limit ${limit}` });
    expect(yield* snapshot(store)).toEqual(before);
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

// Real acceptance/routing establishes selected recipients; only delivery ambiguity is injected.
const delegationTree = (store: Store) => Effect.gen(function* () {
  const root = yield* selectedDelegation(store);
  const handler = agentDelegateHandler(slots, { delegationDepthLimit: () => 3 });

  const delegate = (callId: string, parent: string, slot = responder, recipient = "floor.worker") =>
    Effect.promise(() => submit(store, callId, { recipient, body: callId, parentDelegationId: parent }, slot, handler));

  expect(yield* delegate("child", root.id)).toMatchObject({ status: "committed" });
  yield* bindStationMessages({ store, slots });
  const child = (yield* snapshot(store)).delegations[1]!;
  expect(yield* delegate("grandchild", child.id, sender, "floor.reviewer")).toMatchObject({ status: "committed" });
  expect(yield* delegate("sibling", root.id)).toMatchObject({ status: "committed" });
  // Give the grandchild a distinct selected recipient to exercise descendant-only notification.
  yield* bindStationMessages({ store, slots: slots.filter((slot) => slot.slotId !== "reviewer/1") });
  const [, , grandchild, sibling] = (yield* snapshot(store)).delegations;

  if (grandchild === undefined || sibling === undefined) {throw new Error("tree missing");}

  yield* store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE delegation SET status = 'completed' WHERE id = ?`, [sibling.id]);
    yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "completed-sibling" });
  }));
  yield* holdNotice(store, root.notice_id);
  yield* holdNotice(store, grandchild.notice_id);
  yield* store.change((change) => raiseHoldIn(change, {
    factoryId: "shop", kind: "stuck_worker", subject: grandchild.notice_id, evidence: {},
  }));

  return { root, child, grandchild, sibling };
});

test("dropping a depth-three subtree abandons only open work, closes notice holds, notifies each slot once and unblocks done", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const { root, child, grandchild, sibling } = yield* delegationTree(store);
    const disposition = createMessageDisposition(store);
    const descendants = [child.id, grandchild.id].sort();
    expect(yield* disposition.inspect(root.notice_id)).toMatchObject({ descendantDelegations: descendants });
    const result = yield* disposition.act(root.notice_id, "drop", true);
    expect(result).toMatchObject({ descendantDelegations: descendants });
    expect(yield* store.read(`SELECT id, status FROM delegation ORDER BY rowid`)).toEqual([
      { id: root.id, status: "abandoned" }, { id: child.id, status: "abandoned" },
      { id: grandchild.id, status: "abandoned" }, { id: sibling.id, status: "completed" },
    ]);
    expect(yield* store.read(`SELECT id, status FROM message WHERE kind = 'delegation_notice' ORDER BY sequence`)).toEqual([
      { id: root.notice_id, status: "dropped" }, { id: child.notice_id, status: "dropped" },
      { id: grandchild.notice_id, status: "dropped" }, { id: sibling.notice_id, status: "bound" },
    ]);
    expect(yield* store.read(`SELECT subject, kind, state FROM operator_hold ORDER BY id`)).toEqual([
      { subject: root.notice_id, kind: "indeterminate_message", state: "resolved" },
      { subject: grandchild.notice_id, kind: "indeterminate_message", state: "resolved" },
      { subject: grandchild.notice_id, kind: "stuck_worker", state: "cleared" },
    ]);
    expect(yield* store.read(`SELECT sender_kind, sender_slot, recipient, bound_slot, kind, delivery, status, delegation_id
      FROM message WHERE sender_kind = 'daemon' AND delegation_id = ? ORDER BY recipient`, [root.id])).toEqual(
      ["reviewer/1", "reviewer/2", "worker/1"].map((slot) => ({ sender_kind: "daemon", sender_slot: null, recipient: slot,
        bound_slot: slot, kind: "ordinary", delivery: "after_turn", status: "bound", delegation_id: root.id })),
    );
    const events = yield* store.read<{ subject: string; detail: string }>(`SELECT subject, detail FROM history WHERE kind = 'delegation.abandoned'`);
    expect(events).toHaveLength(3);
    expect(JSON.parse(events.find((row) => row.subject === root.id)!.detail)).toMatchObject({ reason: "notice_dropped", descendants });

    for (const descendant of [child, grandchild]) {
      expect(JSON.parse(events.find((row) => row.subject === descendant.id)!.detail)).toMatchObject({
        reason: "ancestor_dropped", noticeId: root.notice_id, ancestorId: root.id,
      });
    }

    const transitionConfig = Schema.decodeUnknownSync(FactoryConfig)({ ...config,
      production_lines: { standard: { stages: [{ id: "build", station: "floor.worker" }, { id: "review", station: "floor.reviewer" }] } },
    });

    const submissions = createSubmissions({ store, handlers: new Map([[TASK_TRANSITION,
      taskTransitionHandler({ factories: [{ factoryId: "shop", config: transitionConfig }] })]]) });

    expect(yield* Effect.promise(() => submissions.submit(sender, { type: "tool_call", callId: "done-after-drop", tool: TASK_TRANSITION,
      args: { assignmentId: root.root_assignment, outcome: "done", reason: "Ready", evidence: ["proof"] },
    }))).toMatchObject({ status: "committed" });
  }));
});

test("a late subtree failure rolls back root, descendants, notices, holds, notifications and history together", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const { root } = yield* delegationTree(store);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`CREATE TRIGGER refuse_tree BEFORE INSERT ON history
        WHEN NEW.kind = 'delegation.abandoned' AND NEW.subject = '${root.id}'
        BEGIN SELECT RAISE(ABORT, 'subtree fixture failure'); END`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture.trigger", subject: root.id });
    }));
    const before = yield* snapshot(store);
    const holds = yield* store.read(`SELECT * FROM operator_hold`);
    yield* Effect.promise(() => expect(Effect.runPromise(createMessageDisposition(store).act(root.notice_id, "drop", true)))
      .rejects.toThrow(/subtree fixture failure/));
    expect(yield* snapshot(store)).toEqual(before);
    expect(yield* store.read(`SELECT * FROM operator_hold`)).toEqual(holds);
  }));
});

test.each(["completed", "abandoned", "cancelled"])("cascade traverses %s intermediates but never crosses factory boundaries", async (status) => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const { root, child, grandchild } = yield* delegationTree(store);
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = ? WHERE id = ?`, [status, child.id]);
      // A deliberately inconsistent cross-factory link proves each recursive step is scoped.
      yield* change.query(`INSERT INTO message (id, factory_id, sequence, sender_kind, sender_slot, recipient, body,
        delivery, kind, status, accepted_at) VALUES ('foreign-notice', 'other', 1, 'daemon', NULL,
        'floor.worker', 'foreign', 'after_turn', 'delegation_notice', 'unbound', 1),
        ('foreign-root-notice', 'other', 2, 'daemon', NULL, 'floor.worker', 'foreign',
        'after_turn', 'delegation_notice', 'unbound', 1)`);
      yield* change.query(`INSERT INTO delegation (id, factory_id, root_assignment, parent_id, delegating_slot, recipient,
        depth, notice_id, status, accepted_at) VALUES ('foreign', 'other', ?, ?, 'foreign/1', 'floor.worker', 3, ?, 'open', 1)`,
        [root.root_assignment, child.id, "foreign-notice"]);
      yield* change.query(`INSERT INTO delegation (id, factory_id, root_assignment, parent_id, delegating_slot, recipient,
        depth, notice_id, status, accepted_at) VALUES ('foreign-root', 'other', ?, ?, 'foreign/1', 'floor.worker', 2, ?, 'open', 1)`,
        [root.root_assignment, root.id, "foreign-root-notice"]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "closed-intermediate" });
    }));
    const disposition = createMessageDisposition(store);
    expect(yield* disposition.inspect(root.notice_id)).toMatchObject({ descendantDelegations: [grandchild.id] });
    yield* disposition.act(root.notice_id, "drop", true);
    expect(yield* store.read(`SELECT id, status FROM delegation WHERE id IN (?, ?, 'foreign', 'foreign-root') ORDER BY id`, [child.id, grandchild.id]))
      .toEqual([{ id: child.id, status }, { id: grandchild.id, status: "abandoned" },
        { id: "foreign", status: "open" }, { id: "foreign-root", status: "open" }].sort((a, b) => a.id.localeCompare(b.id)));
    expect(yield* store.read(`SELECT status FROM message WHERE factory_id = 'other' ORDER BY sequence`))
      .toEqual([{ status: "unbound" }, { status: "unbound" }]);
  }));
});


test.each(["unbound", "bound", "indeterminate", "sent", "acknowledged", "dropped"])("descendant notice %s is changed only if undelivered; action rereads after inspection", async (status) => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const root = yield* selectedDelegation(store);
    yield* holdNotice(store, root.notice_id);
    const disposition = createMessageDisposition(store);
    expect(yield* disposition.inspect(root.notice_id)).toMatchObject({ descendantDelegations: [] });
    // Sequential state changes, not a concurrent-writer assumption: inspect is advisory.
    expect(yield* Effect.promise(() => submit(store, "late-child", {
      recipient: "floor.worker", body: "Child", parentDelegationId: root.id,
    }, responder))).toMatchObject({ status: "committed" });
    const child = (yield* snapshot(store)).delegations[1]!;

    if (status !== "unbound") {yield* bindStationMessages({ store, slots });}

    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET status = ? WHERE id = ?`, [status, child.notice_id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "notice-status" });
    }));
    expect(yield* disposition.act(root.notice_id, "drop", true)).toMatchObject({ descendantDelegations: [child.id] });
    const expected = ["unbound", "bound", "indeterminate"].includes(status) ? "dropped" : status;
    expect(yield* store.read(`SELECT status FROM message WHERE id = ?`, [child.notice_id])).toEqual([{ status: expected }]);
    expect(yield* store.read(`SELECT status FROM delegation`)).toEqual([{ status: "abandoned" }, { status: "abandoned" }]);
    // An unselected child contributes no null/phantom destination.
    expect(yield* store.read(`SELECT recipient FROM message WHERE sender_kind = 'daemon' AND delegation_id = ? ORDER BY recipient`, [root.id]))
      .toEqual([{ recipient: "reviewer/1" }, { recipient: "worker/1" }]);
  }));
});

test("closed root and unrelated subtree retain open descendants and send no cascade notifications", async () => {
  await withStore(await fixture(), (store) => Effect.gen(function* () {
    const { root, child, grandchild } = yield* delegationTree(store);
    // A separate root in the same assignment must not be mistaken for a descendant.
    expect(yield* Effect.promise(() => submit(store, "unrelated"))).toMatchObject({ status: "committed" });
    const unrelated = (yield* snapshot(store)).delegations.at(-1)!;
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = 'completed' WHERE id = ?`, [root.id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "closed-root" });
    }));
    const disposition = createMessageDisposition(store);
    expect(yield* disposition.inspect(root.notice_id)).toMatchObject({ descendantDelegations: [] });
    yield* disposition.act(root.notice_id, "drop", true);
    expect(yield* store.read(`SELECT id FROM message WHERE sender_kind = 'daemon' AND delegation_id = ?`, [root.id])).toEqual([]);
    expect(yield* store.read(`SELECT id, status FROM delegation WHERE id IN (?, ?) ORDER BY id`, [child.id, grandchild.id]))
      .toEqual([child, grandchild].map((row) => ({ id: row.id, status: "open" })).sort((a, b) => a.id.localeCompare(b.id)));
    // Reopen only the root to prove the narrower-than-assignment scope on a real cascade too.
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE delegation SET status = 'open' WHERE id = ?`, [root.id]);
      yield* change.query(`UPDATE message SET status = 'indeterminate' WHERE id = ?`, [root.notice_id]);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "reopen-root" });
    }));
    yield* disposition.act(root.notice_id, "drop", true);
    expect(yield* store.read(`SELECT status FROM delegation WHERE id = ?`, [unrelated.id])).toEqual([{ status: "open" }]);
    expect(yield* store.read(`SELECT status FROM message WHERE id = ?`, [unrelated.notice_id])).toEqual([{ status: "unbound" }]);
  }));
});
