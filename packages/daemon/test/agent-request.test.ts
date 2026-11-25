// Integration tier: real disposable SQLite proves the request/notice/submission transaction.
// No recipient process, channel or timer exists in this fixture: acceptance must finish without one.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Clock, Effect } from "effect";
import { agentRequestHandler, createSubmissions, openStore, ToolRefusal } from "@foundry/daemon";
import type { MessageAcceptanceGuards, PlannedSlot, Store, ToolHandler } from "@foundry/daemon";
import { AGENT_REQUEST } from "@foundry/protocol";

const dirs: Array<string> = [];

afterEach(async () => { for (const dir of dirs.splice(0)) {await rm(dir, { recursive: true, force: true });} });

const database = async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-request-"));
  dirs.push(dir);

  return join(dir, "foundry.db");
};

const withStore = <A, E>(filename: string, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename }), use)));

const slot = (factoryId: string, address: string): PlannedSlot => ({
  factoryId, slotId: `${address}/1`, ordinal: 1,
  station: { address, room: "eng", station: "reviewer", instructions: [], model: "faux/scripted",
    skills: [], extensions: [], instances: 1, isolation: "none" },
});

const slots = [slot("alpha", "eng.reviewer"), slot("beta", "ops.deployer")];
const sender = { factoryId: "alpha", slotId: "builder/1", launchId: "launch-1" };
const args = { recipient: "eng.reviewer", body: "Please review ✓", timeoutMs: 60_000 };
const now = 1_800_000_000_000;

/** Override only wall time; no wall-clock tolerances or sleeps in deadline assertions. */
const at = (time: number, handler: ToolHandler): ToolHandler => (change, call) => Clock.clockWith((clock) =>
  handler(change, call).pipe(Effect.provideService(Clock.Clock, {
    currentTimeMillis: Effect.succeed(time), currentTimeMillisUnsafe: () => time,
    currentTimeNanos: clock.currentTimeNanos, currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos, monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    sleep: (duration) => clock.sleep(duration),
  })),
);

const dispatcher = (store: Store, handler = agentRequestHandler(slots)) =>
  createSubmissions({ store, handlers: new Map([[AGENT_REQUEST, at(now, handler)]]) });

const snapshot = (store: Store) => Effect.all({
  requests: store.read<{ id: string; notice_id: string }>(`SELECT * FROM agent_request`),
  messages: store.read(`SELECT * FROM message`),
  submissions: store.read(`SELECT * FROM submission`),
  history: store.read<{ kind: string }>(`SELECT kind, subject, detail FROM history ORDER BY sequence`),
});

test("returns a durable ID and absolute deadline without a recipient, then replays unchanged after downtime", async () => {
  const filename = await database();

  const result = await withStore(filename, (store) => Effect.promise(async () => {
    const calls = dispatcher(store);

    const outcome = await calls.submit(sender, { type: "tool_call", callId: "one", tool: AGENT_REQUEST, args: {
      ...args, factoryId: "beta", senderSlot: "spoof", ticket: 999,
      requestId: "spoof", deadline: 1, recipientSlot: "spoof",
    } });

    expect(outcome).toEqual({ status: "committed", value: { requestId: expect.any(String), deadline: now + args.timeoutMs } });
    const state = await Effect.runPromise(snapshot(store));
    expect(state.requests).toEqual([{
      id: expect.any(String), factory_id: "alpha", requester_slot: sender.slotId, recipient: args.recipient,
      recipient_slot: null, ticket_number: null, notice_id: expect.any(String), status: "open",
      accepted_at: now, deadline: now + args.timeoutMs,
    }]);
    expect(state.messages).toMatchObject([{
      id: state.requests[0]?.notice_id, request_id: state.requests[0]?.id, factory_id: "alpha",
      sender_slot: sender.slotId, kind: "request_notice", recipient: args.recipient, body: args.body,
      delivery: "after_turn", ticket_number: null, status: "unbound",
    }]);
    expect(outcome).toMatchObject({ value: { requestId: state.requests[0]?.id } });
    expect(state.submissions).toMatchObject([{ result: JSON.stringify(outcome.status === "committed" ? outcome.value : null) }]);
    expect(state.history.map((row) => row.kind)).toEqual(["message.accepted", "request.accepted", "submission.recorded"]);

    return { outcome, state };
  }));

  await withStore(filename, (store) => Effect.promise(async () => {
    const calls = dispatcher(store, at(now + 1_000_000, agentRequestHandler(slots)));
    expect(await calls.submit(sender, { type: "tool_call", callId: "one", tool: AGENT_REQUEST, args: {} })).toEqual(result.outcome);
    expect(await Effect.runPromise(snapshot(store))).toEqual(result.state);
    expect(await calls.submit(sender, { type: "tool_call", callId: "two", tool: AGENT_REQUEST,
      args: { ...args, delivery: "when_idle" },
    })).toMatchObject({ status: "committed", value: { deadline: now + 1_000_000 + args.timeoutMs } });
    expect(await Effect.runPromise(store.read(`SELECT id FROM agent_request`))).toHaveLength(2);
    expect(await Effect.runPromise(store.read(`SELECT delivery FROM message ORDER BY sequence`)))
      .toEqual([{ delivery: "after_turn" }, { delivery: "when_idle" }]);
  }));
});

test("rejects invalid deadlines, delivery and cross-factory recipients without any durable effects", async () => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const calls = dispatcher(store);

    for (const invalid of [{}, { ...args, timeoutMs: 0 }, { ...args, timeoutMs: -1 },
      { ...args, timeoutMs: 0.5 }, { ...args, timeoutMs: "60000" }, { ...args, timeoutMs: Number.MAX_SAFE_INTEGER },
      { ...args, delivery: "urgent" }, { ...args, recipient: "" }, { ...args, body: 42 }]) {
      expect(await calls.submit(sender, { type: "tool_call", callId: "bad", tool: AGENT_REQUEST, args: invalid }))
        .toMatchObject({ status: "refused", code: "invalid_arguments" });
    }

    expect(await calls.submit(sender, { type: "tool_call", callId: "foreign", tool: AGENT_REQUEST,
      args: { ...args, recipient: "ops.deployer", factoryId: "beta" },
    })).toMatchObject({ status: "refused", code: "unknown_recipient" });
    expect(await Effect.runPromise(snapshot(store))).toEqual({ requests: [], messages: [], submissions: [], history: [] });
  }));
});

test("request, notice, budget and submission roll back together on SQL failure or refusal", async () => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const guards: MessageAcceptanceGuards = {
      assignmentTicket: () => Effect.succeed(42),
      budget: (change, message) => change.recordHistory({ factoryId: message.factoryId, kind: "budget.charged", subject: String(message.ticket) }).pipe(Effect.asVoid),
    };

    const handler = agentRequestHandler(slots, guards);

    const failAfterAcceptance: ToolHandler = (change, call) => Effect.gen(function* () {
      yield* handler(change, call);
      yield* change.query(`INSERT INTO nonexistent_table VALUES (1)`);

      return null;
    });

    const refuseBudget = agentRequestHandler(slots, { ...guards, budget: (change) => Effect.gen(function* () {
      yield* change.recordHistory({ factoryId: "alpha", kind: "budget.probe", subject: "rollback" });

      return yield* new ToolRefusal({ code: "budget_refused", detail: "test" });
    }) });

    for (const failing of [failAfterAcceptance, refuseBudget]) {
      expect(await dispatcher(store, failing).submit(sender, { type: "tool_call", callId: "retry", tool: AGENT_REQUEST, args }))
        .toMatchObject({ status: "refused" });
      expect(await Effect.runPromise(snapshot(store))).toEqual({ requests: [], messages: [], submissions: [], history: [] });
    }

    expect(await dispatcher(store, handler).submit(sender, { type: "tool_call", callId: "retry", tool: AGENT_REQUEST, args }))
      .toMatchObject({ status: "committed" });
    const state = await Effect.runPromise(snapshot(store));
    expect(state.requests).toMatchObject([{ ticket_number: 42 }]);
    expect(state.messages).toMatchObject([{ ticket_number: 42, sequence: 1 }]);
    expect(state.history.map((row) => row.kind)).toEqual(["budget.charged", "message.accepted", "request.accepted", "submission.recorded"]);
    expect(state.submissions).toHaveLength(1);
  }));
});
