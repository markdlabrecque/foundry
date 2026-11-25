// Integration tier: the acceptance boundary is a real disposable SQLite file, reopened after success.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { acceptMessage, agentMessageHandler, createSubmissions, openStore, ToolRefusal } from "@foundry/daemon";
import type { MessageAcceptanceGuards, Store, ToolHandler } from "@foundry/daemon";
import { AGENT_MESSAGE } from "@foundry/protocol";

const dirs: Array<string> = [];

afterEach(async () => { for (const dir of dirs.splice(0)) {await rm(dir, { recursive: true, force: true });} });

const database = async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-message-"));
  dirs.push(dir);

  return join(dir, "foundry.db");
};

const withStore = <A, E>(filename: string, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename }), use)));

const configuredHandler = (guards: MessageAcceptanceGuards = {}) => agentMessageHandler([
  { factoryId: "alpha", slotId: "builder/1", ordinal: 1, station: {
    address: "eng.builder", room: "eng", station: "builder", instructions: [], model: "faux/scripted",
    skills: [], extensions: [], instances: 1, isolation: "none",
  } },
  { factoryId: "beta", slotId: "deployer/1", ordinal: 1, station: {
    address: "ops.deployer", room: "ops", station: "deployer", instructions: [], model: "faux/scripted",
    skills: [], extensions: [], instances: 1, isolation: "none",
  } },
  { factoryId: "beta", slotId: "builder/1", ordinal: 1, station: {
    address: "eng.builder", room: "eng", station: "builder", instructions: [], model: "faux/scripted",
    skills: [], extensions: [], instances: 1, isolation: "none",
  } },
], guards);

const sender = { factoryId: "alpha", slotId: "builder/1", launchId: "launch-1" };
const args = { recipient: "eng.builder", body: "Durable body\nwith unicode: ✓" };

const dispatcher = (store: Store, handler: ToolHandler = configuredHandler()) =>
  createSubmissions({ store, handlers: new Map([[AGENT_MESSAGE, handler]]) });

const snapshot = (store: Store) => Effect.all({
  messages: store.read(`SELECT * FROM message ORDER BY factory_id, sequence`),
  submissions: store.read(`SELECT * FROM submission`),
  history: store.read(`SELECT kind FROM history ORDER BY sequence`),
});

test("acceptance survives reopen, isolates spoofed scope, and replays without accepting twice", async () => {
  const filename = await database();

  const outcome = await withStore(filename, (store) => Effect.promise(async () => {
    const calls = dispatcher(store);

    const first = await calls.submit(sender, { type: "tool_call", callId: "one", tool: AGENT_MESSAGE, args: {
      ...args, sender: "deployer/1", factory: "beta", factoryId: "beta", ticket: 999,
      requestId: "spoof", delegationId: "spoof", kind: "reply",
    } });

    expect(first).toMatchObject({ status: "committed", value: {
      factoryId: "alpha", senderSlot: "builder/1", sequence: 1, body: args.body, delivery: "after_turn",
      status: "unbound", kind: "ordinary", ticket: null, requestId: null, delegationId: null,
    } });
    expect(await calls.submit(sender, { type: "tool_call", callId: "foreign", tool: AGENT_MESSAGE,
      args: { recipient: "ops.deployer", body: "cross-factory", factoryId: "beta" },
    })).toMatchObject({ status: "refused", code: "unknown_recipient" });

    return first;
  }));

  await withStore(filename, (store) => Effect.promise(async () => {
    const calls = dispatcher(store);
    expect(await calls.submit(sender, { type: "tool_call", callId: "one", tool: AGENT_MESSAGE, args: {} })).toEqual(outcome);
    const second = await calls.submit(sender, { type: "tool_call", callId: "two", tool: AGENT_MESSAGE, args });
    expect(second).toMatchObject({ status: "committed", value: { sequence: 2 } });

    const beta = await calls.submit({ ...sender, factoryId: "beta", launchId: "launch-2" }, {
      type: "tool_call", callId: "three", tool: AGENT_MESSAGE, args: { recipient: "ops.deployer", body: "beta", delivery: "when_idle" },
    });

    expect(beta).toMatchObject({ status: "committed", value: { sequence: 1, factoryId: "beta", delivery: "when_idle" } });
    const state = await Effect.runPromise(snapshot(store));
    expect(state.messages).toMatchObject([
      { factory_id: "alpha", sender_slot: "builder/1", sequence: 1, body: args.body, status: "unbound" },
      { factory_id: "alpha", sequence: 2 }, { factory_id: "beta", sequence: 1 },
    ]);
    expect(state.submissions).toHaveLength(3);
    expect(state.history).toEqual(Array.from({ length: 3 }, () => [{ kind: "message.accepted" }, { kind: "submission.recorded" }]).flat());
  }));
});

test("assignment and budget guards share the transaction; correlation takes precedence", async () => {
  const filename = await database();
  await withStore(filename, (store) => Effect.promise(async () => {
    const guards: MessageAcceptanceGuards = {
      assignmentTicket: (_change, factory, slot) => {
        expect([factory, slot]).toEqual(["alpha", "builder/1"]);

        return Effect.succeed(42);
      },
      budget: (change, message) => change.recordHistory({
        factoryId: message.factoryId, kind: "budget.probe", subject: String(message.ticket),
      }).pipe(Effect.asVoid),
    };

    const calls = dispatcher(store, configuredHandler(guards));
    expect(await calls.submit(sender, { type: "tool_call", callId: "assigned", tool: AGENT_MESSAGE, args }))
      .toMatchObject({ status: "committed", value: { ticket: 42 } });

    for (const ticket of [7, null]) {
      const message = await Effect.runPromise(store.change((change) => acceptMessage(change, {
        factoryId: "alpha", senderSlot: "builder/1", ...args, kind: "reply", delivery: "after_turn",
        correlation: { ticket, requestId: "req-1", delegationId: "del-1" },
      }, guards)));

      expect(message).toMatchObject({ ticket, requestId: "req-1", delegationId: "del-1" });
    }

    expect(await Effect.runPromise(store.read(`SELECT ticket_number, request_id, delegation_id FROM message ORDER BY sequence`)))
      .toEqual([
        { ticket_number: 42, request_id: null, delegation_id: null },
        { ticket_number: 7, request_id: "req-1", delegation_id: "del-1" },
        { ticket_number: null, request_id: "req-1", delegation_id: "del-1" },
      ]);
    const before = await Effect.runPromise(snapshot(store));

    const refusing = dispatcher(store, configuredHandler({ ...guards, budget: (change) => Effect.gen(function* () {
      yield* change.recordHistory({ factoryId: "alpha", kind: "budget.probe", subject: "rollback" });

      return yield* new ToolRefusal({ code: "budget_refused", detail: "probe" });
    }) }));

    expect(await refusing.submit(sender, { type: "tool_call", callId: "refused", tool: AGENT_MESSAGE, args }))
      .toMatchObject({ status: "refused", code: "budget_refused" });
    expect(await Effect.runPromise(snapshot(store))).toEqual(before);
  }));
});

test("invalid arguments and a failure after message insertion leave no accepted message", async () => {
  const filename = await database();
  await withStore(filename, (store) => Effect.promise(async () => {
    const calls = dispatcher(store);

    for (const invalid of [{}, { ...args, delivery: "urgent" }, { ...args, body: 12 }]) {
      expect(await calls.submit(sender, { type: "tool_call", callId: "invalid", tool: AGENT_MESSAGE, args: invalid }))
        .toMatchObject({ status: "refused", code: "invalid_arguments" });
    }

    const handler = configuredHandler();

    const failing = dispatcher(store, (change, call) => Effect.gen(function* () {
      yield* handler(change, call);
      yield* change.query(`INSERT INTO nonexistent_table VALUES (1)`);

      return null;
    }));

    expect(await failing.submit(sender, { type: "tool_call", callId: "failed", tool: AGENT_MESSAGE, args }))
      .toMatchObject({ status: "refused", code: "not_committed" });
    expect(await Effect.runPromise(snapshot(store))).toEqual({ messages: [], submissions: [], history: [] });
    expect(await calls.submit(sender, { type: "tool_call", callId: "failed", tool: AGENT_MESSAGE, args }))
      .toMatchObject({ status: "committed", value: { sequence: 1 } });
  }));
});
