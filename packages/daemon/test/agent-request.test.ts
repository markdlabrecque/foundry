// Integration tier: real disposable SQLite proves the request/notice/submission transaction.
// No recipient process, channel or timer exists in this fixture: acceptance must finish without one.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Clock, Effect } from "effect";
import { acknowledgeMessage, agentReplyHandler, agentRequestHandler, bindStationMessages, createMessageDelivery, createMessageDisposition, createSubmissions, expireRequests, openSlotGate, openStore, raiseHold, startRequestExpiry, ToolRefusal } from "@foundry/daemon";
import type { MessageAcceptanceGuards, PlannedSlot, Store, ToolHandler } from "@foundry/daemon";
import { AGENT_REPLY, AGENT_REQUEST } from "@foundry/protocol";

const dirs: Array<string> = [];

afterEach(async () => { vi.useRealTimers();

 for (const dir of dirs.splice(0)) {await rm(dir, { recursive: true, force: true });} });

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


/** Real acceptance and routing, with no launches: correlation belongs to logical slots. */
const selectedRequest = (store: Store) => Effect.gen(function* () {
  const outcome = yield* Effect.promise(() => dispatcher(store, agentRequestHandler(slots, {
    assignmentTicket: () => Effect.succeed(42),
  })).submit(sender, { type: "tool_call", callId: "request", tool: AGENT_REQUEST, args }));

  expect(outcome.status).toBe("committed");
  yield* store.change((change) => Effect.gen(function* () {
    yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition)
      VALUES ('alpha', 'eng.reviewer/1', 'eng.reviewer', 1, 'normal')`);
    yield* change.recordHistory({ factoryId: "alpha", kind: "fixture", subject: "slots" });
  }));
  yield* bindStationMessages({ store, slots });
  const requests = yield* store.read<{ id: string; recipient_slot: string }>(`SELECT id, recipient_slot FROM agent_request`);
  const request = requests[0];

  if (request === undefined) {throw new Error("request missing");}

  expect(request.recipient_slot).toBe("eng.reviewer/1");

  return request.id;
});

const responder = { factoryId: "alpha", slotId: "eng.reviewer/1", launchId: "replacement-reviewer" };

const replyCalls = (store: Store, time: number, handler = agentReplyHandler()) =>
  createSubmissions({ store, handlers: new Map([[AGENT_REPLY, at(time, handler)]]) });

test("only the selected slot may reply; first valid reply completes atomically and replay cannot duplicate it", async () => {
  const filename = await database();

  const saved = await withStore(filename, (store) => Effect.promise(async () => {
    const requestId = await Effect.runPromise(selectedRequest(store));
    const before = await Effect.runPromise(snapshot(store));
    const calls = replyCalls(store, now + args.timeoutMs - 1);

    const frame = { type: "tool_call", callId: "reply", tool: AGENT_REPLY,
      args: { requestId, body: "reviewed", requesterSlot: "spoof", ticket: 999 } } as const;

    for (const identity of [{ ...responder, slotId: "eng.reviewer/2" }, sender, { ...responder, factoryId: "beta" }]) {
      expect(await calls.submit(identity, frame)).toMatchObject({ status: "refused" });
      expect(await Effect.runPromise(snapshot(store))).toEqual(before);
    }

    const outcome = await calls.submit(responder, frame);
    expect(outcome).toMatchObject({ status: "committed", value: { requestId, status: "completed", replyId: expect.any(String) } });
    const completed = await Effect.runPromise(snapshot(store));
    expect(completed.requests).toMatchObject([{ status: "completed" }]);
    expect(completed.messages).toMatchObject([
      { kind: "request_notice", bound_slot: responder.slotId },
      { kind: "reply", request_id: requestId, ticket_number: 42, body: "reviewed",
        recipient: sender.slotId, bound_slot: sender.slotId, status: "bound" },
    ]);
    expect(completed.history.map((row) => row.kind)).toContain("request.completed");
    expect(await calls.submit({ ...responder, launchId: "new-launch" }, { ...frame, callId: "duplicate" }))
      .toMatchObject({ status: "refused", code: "request_closed" });
    expect(await Effect.runPromise(snapshot(store))).toEqual(completed);

    return { frame, outcome, completed };
  }));

  // Reopen the database after downtime: submission replay is unchanged, even past deadline.
  await withStore(filename, (store) => Effect.promise(async () => {
    expect(await replyCalls(store, now + 999_999).submit(responder, saved.frame)).toEqual(saved.outcome);
    expect(await Effect.runPromise(snapshot(store))).toEqual(saved.completed);
    // Station routing never reconsiders the already bound logical-slot destination.
    expect(await Effect.runPromise(bindStationMessages({ store, slots }))).toEqual([]);
  }));
});

test.each([0, 1])("reply at deadline + %i is durably recorded without completing or routing", async (offset) => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const requestId = await Effect.runPromise(selectedRequest(store));
    const calls = replyCalls(store, now + args.timeoutMs + offset);
    const frame = { type: "tool_call", callId: "late", tool: AGENT_REPLY, args: { requestId, body: "too late" } } as const;
    expect(await calls.submit(responder, frame)).toEqual({ status: "committed", value: { requestId, status: "late" } });
    const state = await Effect.runPromise(snapshot(store));
    expect(state.requests).toMatchObject([{ status: "open" }]);
    expect(state.messages).toHaveLength(1);
    expect(state.submissions).toHaveLength(2);
    expect(state.history).toContainEqual(expect.objectContaining({ kind: "request.reply_late",
      detail: expect.stringContaining("too late") }));
    expect(await calls.submit(responder, frame)).toMatchObject({ status: "committed" });
    expect(await Effect.runPromise(snapshot(store))).toEqual(state);

    // An expiry sweep having closed the request cannot be undone by another late attempt.
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE agent_request SET status = 'expired' WHERE id = ?`, [requestId]);
      yield* change.recordHistory({ factoryId: "alpha", kind: "request.expired", subject: requestId });
    })));
    expect(await calls.submit(responder, { ...frame, callId: "later" })).toMatchObject({ value: { status: "late" } });
    expect(await Effect.runPromise(store.read(`SELECT status FROM agent_request`))).toEqual([{ status: "expired" }]);
    expect(await Effect.runPromise(store.read(`SELECT id FROM message`))).toHaveLength(1);
  }));
});

test("competing reply submissions commit exactly one completion and reply", async () => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const requestId = await Effect.runPromise(selectedRequest(store));
    const calls = replyCalls(store, now + 1);

    const outcomes = await Promise.all(["first", "second"].map((callId) => calls.submit(responder, {
      type: "tool_call", callId, tool: AGENT_REPLY, args: { requestId, body: callId },
    })));

    expect(outcomes.filter((outcome) => outcome.status === "committed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "refused")).toMatchObject([{ code: "request_closed" }]);
    expect(await Effect.runPromise(store.read(`SELECT id FROM message WHERE kind = 'reply'`))).toHaveLength(1);
    expect(await Effect.runPromise(store.read(`SELECT sequence FROM history WHERE kind = 'request.completed'`))).toHaveLength(1);
  }));
});

test("startup and periodic expiry count downtime, preserve attempted copies and never extend deadlines", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(now);
  const filename = await database();

  await withStore(filename, (store) => Effect.promise(async () => {
    await Effect.runPromise(selectedRequest(store));
    const calls = dispatcher(store);

    for (const callId of ["unbound", "future", "completed"]) {
      await calls.submit(sender, { type: "tool_call", callId, tool: AGENT_REQUEST,
        args: { ...args, timeoutMs: callId === "future" ? 120_000 : args.timeoutMs } });
    }

    // The bound notice has one committed attempt, but no receipt yet.
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE message SET status = 'sent' WHERE status = 'bound'`);
      yield* change.query(`INSERT INTO message_attempt (id, factory_id, message_id, slot_id, launch_id, connection_id, sent_at)
        SELECT 'attempt', factory_id, id, bound_slot, 'reviewer', 'connection', ? FROM message WHERE status = 'sent'`, [now]);
      yield* change.query(`UPDATE agent_request SET status = 'completed' WHERE notice_id = (SELECT id FROM message ORDER BY sequence DESC LIMIT 1)`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "fixture", subject: "attempt" });
    })));
  }));

  vi.setSystemTime(now + args.timeoutMs); // Daemon was down all the way to the deadline.
  await withStore(filename, (store) => Effect.promise(async () => {
    const stop = await startRequestExpiry(store, (cause) => { throw cause; });

    try {
      expect(await Effect.runPromise(store.read(`SELECT status, deadline FROM agent_request ORDER BY rowid`))).toEqual([
        { status: "expired", deadline: now + 60_000 }, { status: "expired", deadline: now + 60_000 },
        { status: "open", deadline: now + 120_000 }, { status: "completed", deadline: now + 60_000 },
      ]);
      expect(await Effect.runPromise(store.read(`SELECT status FROM message ORDER BY sequence`))).toEqual([
        { status: "sent" }, { status: "expired" }, { status: "unbound" }, { status: "unbound" },
      ]);
      const notices = await Effect.runPromise(store.read<{ id: string }>(`SELECT id FROM message WHERE status = 'sent'`));
      const notice = notices[0];

      if (notice === undefined) {throw new Error("sent notice missing");}

      expect(await Effect.runPromise(acknowledgeMessage(store, { ...responder, launchId: "reviewer" }, notice.id))).toBe(true);
      expect(await Effect.runPromise(expireRequests(store))).toBe(0);

      // Resolve when the real store commits the periodic transition, without sleeps/polling.
      const committed = new Promise<void>((resolve) => {
        const off = store.onCommit(() => { off(); resolve(); });
      });

      vi.setSystemTime(now + 120_000);
      await vi.advanceTimersByTimeAsync(1000);
      await committed;
      expect(await Effect.runPromise(store.read(`SELECT status FROM agent_request WHERE deadline = ?`, [now + 120_000])))
        .toEqual([{ status: "expired" }]);
      expect(await Effect.runPromise(store.read(`SELECT kind FROM history WHERE kind = 'request.expired'`))).toHaveLength(3);
      expect(await Effect.runPromise(store.read(`SELECT * FROM message_attempt`))).toMatchObject([{ id: "attempt", acknowledged_at: now + 60_000 }]);
    } finally { await stop(); }
  }));
});

test("delivery blocks a bound request at its deadline before a sweep, but sends before it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await withStore(await database(), (store) => Effect.promise(async () => {
    await Effect.runPromise(selectedRequest(store));
    const sent: Array<unknown> = [];
    const errors: Array<unknown> = [];
    const delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => { errors.push(cause); } });

    try {
      vi.setSystemTime(now + args.timeoutMs);
      delivery.attach(responder, { send: async (frame) => { sent.push(frame); } });
      await delivery.idle();
      expect(sent).toEqual([]);
      expect(await Effect.runPromise(store.read(`SELECT * FROM message_attempt`))).toEqual([]);
      expect(await Effect.runPromise(expireRequests(store))).toBe(1);
      expect(await Effect.runPromise(store.read(`SELECT status FROM message`))).toEqual([{ status: "expired" }]);

      // An ordinary new request still delivers normally while its deadline is in the future.
      await dispatcher(store, at(now + 120_000, agentRequestHandler(slots))).submit(sender,
        { type: "tool_call", callId: "fresh", tool: AGENT_REQUEST, args });
      await Effect.runPromise(bindStationMessages({ store, slots }));
      await delivery.idle();
      expect(sent).toMatchObject([{ type: "message", body: args.body }]);
      expect(await Effect.runPromise(store.read(`SELECT * FROM message_attempt`))).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally { await delivery.stop(); }
  }));
});

const failReply: ToolHandler = (change, call) => Effect.gen(function* () {
  yield* agentReplyHandler()(change, call);
  yield* change.query(`INSERT INTO nonexistent_table VALUES (1)`);

  return null;
});

test("reply, completion, history and submission all roll back if the transaction fails", async () => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const requestId = await Effect.runPromise(selectedRequest(store));
    const before = await Effect.runPromise(snapshot(store));

    const frame = { type: "tool_call", callId: "retry", tool: AGENT_REPLY, args: { requestId, body: "reviewed" } } as const;
    expect(await replyCalls(store, now + 1, failReply).submit(responder, frame)).toMatchObject({ status: "refused" });
    expect(await Effect.runPromise(snapshot(store))).toEqual(before);
    expect(await replyCalls(store, now + 1).submit(responder, frame)).toMatchObject({ value: { status: "completed" } });
  }));
});

/** The selected request's notice, made ambiguous and held for the operator (PRD §10.2). */
const heldNotice = (store: Store, requestId: string) => Effect.gen(function* () {
  const [notice] = yield* store.read<{ id: string }>(`SELECT notice_id AS id FROM agent_request WHERE id = ?`, [requestId]);

  if (notice === undefined) {throw new Error("notice missing");}

  yield* store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE message SET status = 'indeterminate' WHERE id = ?`, [notice.id]);
    yield* change.recordHistory({ factoryId: "alpha", kind: "fixture.ambiguous", subject: notice.id });
  }));
  yield* raiseHold(store, { factoryId: "alpha", kind: "indeterminate_message", subject: notice.id, evidence: {} });

  return notice.id;
});

test("dropping a request notice fails the request and notifies the requester in the same transaction", async () => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const requestId = await Effect.runPromise(selectedRequest(store));
    const noticeId = await Effect.runPromise(heldNotice(store, requestId));
    const disposition = createMessageDisposition(store);
    const before = await Effect.runPromise(snapshot(store));

    // A failure late in the drop must leave the drop, the failure and the notification all unwritten.
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`CREATE TRIGGER refuse_failure BEFORE INSERT ON history WHEN NEW.kind = 'request.failed'
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "fixture.trigger", subject: requestId });
    })));
    const armed = await Effect.runPromise(snapshot(store));
    await expect(Effect.runPromise(disposition.act(noticeId, "drop", true))).rejects.toThrow();
    expect(await Effect.runPromise(snapshot(store))).toEqual(armed);
    expect(armed.requests).toEqual(before.requests);
    expect(armed.messages).toEqual(before.messages);
    expect(await Effect.runPromise(store.read(`SELECT state FROM operator_hold`))).toEqual([{ state: "open" }]);
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`DROP TRIGGER refuse_failure`);
      yield* change.recordHistory({ factoryId: "alpha", kind: "fixture.trigger_removed", subject: requestId });
    })));

    // Well before the deadline: the requester hears at once, not when the sweep would expire it.
    await Effect.runPromise(disposition.act(noticeId, "drop", true));
    const after = await Effect.runPromise(snapshot(store));
    expect(after.requests).toMatchObject([{ id: requestId, status: "failed", deadline: now + args.timeoutMs }]);
    const [notification] = await Effect.runPromise(store.read(`SELECT * FROM message WHERE id != ?`, [noticeId]));
    expect(after.messages).toHaveLength(2);
    expect(after.messages).toContainEqual(expect.objectContaining({ id: noticeId, status: "dropped" }));
    expect(notification).toMatchObject({ sender_kind: "daemon", kind: "ordinary", request_id: requestId, ticket_number: 42,
      recipient: sender.slotId, bound_slot: sender.slotId, status: "bound", body: expect.stringContaining(requestId) });
    const dropEvent = after.history.findIndex((row) => row.kind === "message.dropped");
    expect(after.history.slice(dropEvent).map((row) => row.kind))
      .toEqual(["message.dropped", "message.accepted", "message.bound", "request.failed"]);
    expect(await Effect.runPromise(store.read(`SELECT state FROM operator_hold`))).toEqual([{ state: "resolved" }]);

    // The sweep never revisits a failed request, and a late reply cannot complete it.
    expect(await Effect.runPromise(expireRequests(store))).toBe(0);
    expect(await replyCalls(store, now + 1).submit(responder, { type: "tool_call", callId: "late", tool: AGENT_REPLY,
      args: { requestId, body: "reviewed" } })).toMatchObject({ status: "refused", code: "request_closed" });
  }));
});

test("dropping the notice of an already-closed request changes no request and sends no notification", async () => {
  await withStore(await database(), (store) => Effect.promise(async () => {
    const requestId = await Effect.runPromise(selectedRequest(store));
    const noticeId = await Effect.runPromise(heldNotice(store, requestId));
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`UPDATE agent_request SET status = 'completed' WHERE id = ?`, [requestId]);
      yield* change.recordHistory({ factoryId: "alpha", kind: "fixture.completed", subject: requestId });
    })));
    await Effect.runPromise(createMessageDisposition(store).act(noticeId, "drop", true));
    const after = await Effect.runPromise(snapshot(store));
    expect(after.requests).toMatchObject([{ status: "completed" }]);
    expect(after.messages).toMatchObject([{ id: noticeId, status: "dropped" }]);
    expect(after.history.map((row) => row.kind)).not.toContain("request.failed");
  }));
});
