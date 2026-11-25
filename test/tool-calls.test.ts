// Tier: integration. Real boundaries: the Unix-socket channel between the daemon's server and the
// extension's tool-call client, and a real SQLite store file. The tool handler is a bounded test
// double whose only effect is one history row per call, so effects can be counted. Claims: a result
// reaches the worker only after its commit, a call whose result was lost is answered from the
// stored result without repeating its effect, and equal arguments under distinct call IDs stay two
// submissions.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { createSubmissions, openStore, startChannelServer, ToolRefusal } from "@foundry/daemon";
import type { SlotClaim, SlotGate, Store, ToolHandler } from "@foundry/daemon";
import { openChannel, ToolCallClient } from "@foundry/extension";
import type { OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  factoryId: "f1",
  slotId: "builder/1",
  launchId: "launch-1",
  conversationRef: "conv-1",
  hasRecoverableHistory: false,
  mode: "headless",
  tools: [],
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

/** A promise with its resolver, for stepping the journey by hand. */
const signal = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => { resolve = r; });

  return { promise, resolve };
};

/** Bounded, so a missing step fails naming the step rather than as a vitest timeout. */
const within = <A>(step: string, promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${step}`)), 2000).unref(); }),
  ]);

/** The test handler's effect: one `test.effect` history row per executed call. */
const effectHandler =
  (beforeReturn: () => Promise<void> = async () => {}): ToolHandler =>
  (change, call) =>
    Effect.gen(function* () {
      yield* change.recordHistory({ factoryId: call.factoryId, kind: "test.effect", subject: call.callId, detail: call.args });
      yield* Effect.promise(beforeReturn);

      return { echoed: call.args };
    });

const fixture = async (handlers: ReadonlyMap<string, ToolHandler>, gate?: SlotGate) => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-tool-calls-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store: Store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(dir, "foundry.db") })));

  // Counts `tool_call` frames the daemon has read, so a test can wait for a re-send to arrive.
  let toolCallFrames = 0;
  const frameWaiters: Array<{ count: number; resolve: () => void }> = [];

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    toolCalls: createSubmissions(gate === undefined ? { store, handlers } : { store, handlers, gate }),
    onFrame: (_slot, frame) => {
      if (frame.type !== "tool_call") {return;}

      toolCallFrames += 1;

      for (const waiter of frameWaiters.filter((w) => toolCallFrames >= w.count)) {
        frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
  });

  /** Resolves once the daemon has read at least `count` tool calls. */
  const toolCallsRead = (count: number): Promise<void> =>
    toolCallFrames >= count ? Promise.resolve() : new Promise((resolve) => { frameWaiters.push({ count, resolve }); });

  cleanups.push(() => server.close());

  // The channel wait never expires here; the disconnected timeout is proved in the extension's unit test.
  const client = new ToolCallClient({ timer: () => () => {} });

  const connect = async (): Promise<OpenChannel> => {
    const opened = await openChannel({
      socketPath: server.socketPath,
      hello,
      onFrame: (frame) => {
        if (frame.type === "tool_result") {client.receive(frame);}
      },
    });

    if (!opened.accepted) {throw new Error("hello was not accepted");}

    cleanups.push(() => opened.channel.close());
    client.attach(opened.channel);

    return opened.channel;
  };

  const effects = async () =>
    (await Effect.runPromise(store.read<{ subject: string }>(`SELECT subject FROM history WHERE kind = 'test.effect' ORDER BY sequence`))).map(
      (row) => row.subject,
    );

  const submissions = () =>
    Effect.runPromise(store.read<{ call_id: string; result: string }>(`SELECT call_id, result FROM submission ORDER BY call_id`));

  return { store, client, connect, effects, submissions, toolCallsRead };
};

test("a tool result reaches the worker only after its submission and effects commit", async () => {
  const started = signal();
  const release = signal();

  const { store, client, connect, effects, submissions } = await fixture(
    new Map([["echo", effectHandler(async () => { started.resolve(); await release.promise; })]]),
  );

  await connect();
  const order: Array<string> = [];
  store.onCommit(() => order.push("commit"));

  const result = client.call("call-1", "echo", { n: 1 }).then((outcome) => (order.push("result"), outcome));
  await within("the handler to start", started.promise);
  release.resolve();

  expect(await within("the result", result)).toEqual({ status: "committed", value: { echoed: { n: 1 } } });
  expect(order).toEqual(["commit", "result"]);
  expect(await effects()).toEqual(["call-1"]);
  expect(await submissions()).toEqual([{ call_id: "call-1", result: JSON.stringify({ echoed: { n: 1 } }) }]);
});

/** Writes its effect, then refuses, so the whole call must roll back. */
const refusing: ToolHandler = (change, call) =>
  Effect.gen(function* () {
    yield* change.recordHistory({ factoryId: call.factoryId, kind: "test.effect", subject: call.callId });

    return yield* new ToolRefusal({ code: "bad_args", detail: "no" });
  });

test("a handler that refuses after writing rolls its effect back and reports nothing committed", async () => {
  const { client, connect, effects, submissions } = await fixture(new Map([["refuse", refusing]]));
  await connect();

  expect(await within("the result", client.call("call-1", "refuse", {}))).toEqual({ status: "refused", code: "bad_args", detail: "no" });
  expect(await effects()).toEqual([]);
  expect(await submissions()).toEqual([]);
});

test("a call whose result was lost with its channel is answered from the stored result on the next channel", async () => {
  const started = signal();
  const release = signal();
  let calls = 0;

  const { store, client, connect, effects } = await fixture(
    new Map([["echo", effectHandler(async () => {
      calls += 1;

      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
    })]]),
  );

  const first = await connect();

  const result = client.call("call-1", "echo", { n: 1 });
  await within("the handler to start", started.promise);
  // The channel goes away while the daemon is committing, so the result has nowhere to go.
  first.close();
  await within("the first channel to close", first.closed);
  // The commit lands with no channel to carry its result.
  const committed = signal();
  store.onCommit(() => committed.resolve());
  release.resolve();
  await within("the effect to commit", committed.promise);

  await connect();

  expect(await within("the replayed result", result)).toEqual({ status: "committed", value: { echoed: { n: 1 } } });
  expect(await effects()).toEqual(["call-1"]);
  expect(calls).toBe(1);
});

test("a call re-sent while its original is still committing waits for that commit and replays its result", async () => {
  const started = signal();
  const release = signal();
  let calls = 0;

  const { client, connect, effects, submissions, toolCallsRead } = await fixture(
    new Map([["echo", effectHandler(async () => {
      calls += 1;
      started.resolve();
      await release.promise;
    })]]),
  );

  const first = await connect();
  const result = client.call("call-1", "echo", { n: 1 });
  await within("the handler to start", started.promise);

  // The original is mid-transaction when its channel goes and the re-send reaches the daemon.
  first.close();
  await within("the first channel to close", first.closed);
  await connect();
  await within("the re-sent call to arrive", toolCallsRead(2));
  release.resolve();

  expect(await within("the replayed result", result)).toEqual({ status: "committed", value: { echoed: { n: 1 } } });
  expect(calls).toBe(1);
  expect(await effects()).toEqual(["call-1"]);
  expect((await submissions()).map((s) => s.call_id)).toEqual(["call-1"]);
});

test("two calls with equal arguments and distinct call IDs are two submissions with two effects", async () => {
  const { client, connect, effects, submissions } = await fixture(new Map([["echo", effectHandler()]]));
  await connect();

  const outcomes = await within("both results", Promise.all([client.call("call-a", "echo", { n: 1 }), client.call("call-b", "echo", { n: 1 })]));

  expect(outcomes).toEqual([
    { status: "committed", value: { echoed: { n: 1 } } },
    { status: "committed", value: { echoed: { n: 1 } } },
  ]);
  expect(await effects()).toEqual(["call-a", "call-b"]);
  expect((await submissions()).map((s) => s.call_id)).toEqual(["call-a", "call-b"]);
});

test("a frozen slot's calls are refused with nothing committed, while a call committed before the freeze still replays", async () => {
  let frozen = false;
  const gate: SlotGate = { isFrozen: () => frozen, onUnfrozen: () => () => {} };
  const { client, connect, effects } = await fixture(new Map([["echo", effectHandler()]]), gate);
  await connect();
  await within("the first result", client.call("call-1", "echo", {}));

  frozen = true;

  expect(await within("the refusal", client.call("call-2", "echo", {}))).toEqual({
    status: "refused",
    code: "slot_frozen",
    detail: expect.any(String),
  });
  expect(await within("the replay", client.call("call-1", "echo", {}))).toEqual({ status: "committed", value: { echoed: {} } });
  expect(await effects()).toEqual(["call-1"]);
});
