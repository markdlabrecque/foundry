// Tier: integration. Real boundaries: the Unix-socket channel between the
// daemon's server and the extension's client, a real SQLite store file, and
// (in the receipt test) Pi 1.6.0's own session persistence run in-process with
// the faux model. The slot claim is a test double; it is covered elsewhere.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { composePrime, createPrimer, openStore, primesForConversation, startChannelServer } from "@foundry/daemon";
import type { AcceptedConnection, AcknowledgeOutcome, ChannelServer, PrimedConnection, Primer, PrimeRequest, SlotClaim, Store } from "@foundry/daemon";
import { createConversationAdapter, openChannel, ReceiptReporter, receiveDaemonFrames, RunInterrupter } from "@foundry/extension";
import type { ConversationAdapter, OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame, Hello } from "@foundry/protocol";
import { startFauxSession } from "@foundry/testkit";

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  factoryId: "f1",
  slotId: "builder-1",
  launchId: "launch-1",
  conversationRef: "conv-1",
  hasRecoverableHistory: false,
  mode: "headless",
  tools: [{ name: "read", source: "pi" }],
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

let dir: string;
let scope: Scope.Closeable;
let store: Store;
let server: ChannelServer | undefined;
let session: AgentSession | undefined;
const channels: Array<OpenChannel> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-prime-"));
  await mkdir(join(dir, "factory", "instructions"), { recursive: true });
  await writeFile(join(dir, "factory", "instructions", "factory.md"), "Be careful.\n");
  await writeFile(join(dir, "factory", "instructions", "builder.md"), "You build things.\n");
  scope = await Effect.runPromise(Scope.make());
  store = await Effect.runPromise(openStore({ filename: join(dir, "foundry.db") }).pipe(Scope.provide(scope)));
});

afterEach(async () => {
  for (const channel of channels.splice(0)) {channel.close();}

  await server?.close();
  server = undefined;
  session?.dispose();
  session = undefined;
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await rm(dir, { recursive: true, force: true });
});

const primeRequest = (): Omit<PrimeRequest, "situation"> => ({
  address: "build.builder",
  slotId: "builder-1",
  isolation: "worktree",
  instructions: [join(dir, "factory", "instructions", "factory.md"), join(dir, "factory", "instructions", "builder.md")],
  knowledgeRoot: join(dir, "knowledge"),
  baseDir: join(dir, "factory"),
});

/** A daemon whose primer runs on every accepted connection and consumes every receipt. */
const serveDaemon = async (primer: Primer) => {
  const accepted: Array<PrimedConnection> = [];
  const acceptedWaiters: Array<(c: PrimedConnection) => void> = [];
  let taken = 0;
  const receipts: Array<Promise<AcknowledgeOutcome>> = [];
  const receiptWaiters: Array<(o: Promise<AcknowledgeOutcome>) => void> = [];
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot, h, connection) => {
      accepted.push(primer.prime(slot, h, connection));

      if (acceptedWaiters.length > 0) {acceptedWaiters.shift()!(accepted[taken++]!);}
    },
    onFrame: (slot, frame) => {
      if (frame.type !== "receipt") {return;}

      const outcome = primer.receipt(slot, frame.id);
      receipts.push(outcome);
      receiptWaiters.shift()?.(outcome);
    },
  });

  return {
    /** The next accepted connection not yet taken, in acceptance order. */
    nextAccepted: (): Promise<PrimedConnection> =>
      new Promise((resolve) => {
        if (taken < accepted.length) {resolve(accepted[taken++]!);}
        else {acceptedWaiters.push(resolve);}
      }),
    nextReceipt: (): Promise<AcknowledgeOutcome> =>
      new Promise((resolve) => receiptWaiters.push((o) => void o.then(resolve))),
  };
};

const connect = async (onFrame: (frame: DaemonFrame, channel: OpenChannel) => void, h: Hello = hello): Promise<OpenChannel> => {
  const opened = await openChannel({ socketPath: server!.socketPath, hello: h, heartbeatIntervalMs: 60_000, onFrame });

  if (!opened.accepted) {throw new Error("hello was not accepted");}

  channels.push(opened.channel);

  return opened.channel;
};

const conversationPrimes = () => Effect.runPromise(primesForConversation(store, "f1", "builder-1", "conv-1"));

const history = () =>
  Effect.runPromise(store.read<{ kind: string; subject: string; detail: string }>(`SELECT kind, subject, detail FROM history ORDER BY sequence`));

test("the fresh prime is recorded unacknowledged and reaches the worker before any later frame on that connection", async () => {
  // Composition is held open so a later frame is queued while priming is still in progress.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));

  const primer = createPrimer({
    store,
    primeRequest,
    compose: async (request) => {
      await held;

      return composePrime(request);
    },
    newPrimeId: () => "prime-1",
  });

  const daemon = await serveDaemon(primer);
  const received: Array<DaemonFrame> = [];
  let seenTwo!: () => void;
  const twoFrames = new Promise<void>((r) => (seenTwo = r));
  await connect((frame) => {
    received.push(frame);

    if (received.length === 2) {seenTwo();}
  });

  const primed = await daemon.nextAccepted();
  // Stand-in for a later work frame (messages arrive in 15); it must wait behind the prime.
  const later = primed.connection.send({ type: "prime", id: "later-frame", text: "after" });
  release();

  expect(await primed.outcome).toEqual({ _tag: "Sent", primeId: "prime-1" });
  await later;
  await twoFrames;
  expect(received.map((f) => (f.type === "prime" ? f.id : f.type))).toEqual(["prime-1", "later-frame"]);
  expect(received[0]).toMatchObject({ type: "prime", text: expect.stringContaining("Situation: fresh") });

  const [record] = await conversationPrimes();
  expect(record).toMatchObject({
    id: "prime-1",
    launchId: "launch-1",
    situation: "fresh",
    acknowledgedAt: null,
    parts: [
      { source: "instructions/factory.md", hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      { source: "instructions/builder.md", hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ],
  });
  expect(await history()).toMatchObject([{ kind: "prime.sent", subject: "builder-1" }]);
});

test("a reconnect from the same launch is not primed again, and a missing instruction file sends and records nothing", async () => {
  const primer = createPrimer({ store, primeRequest, newPrimeId: () => "prime-1" });
  const daemon = await serveDaemon(primer);

  const first = await connect(() => {});
  expect(await (await daemon.nextAccepted()).outcome).toMatchObject({ _tag: "Sent" });
  first.close();
  await first.closed;

  await connect(() => {});
  expect(await (await daemon.nextAccepted()).outcome).toEqual({ _tag: "Reconnect", unacknowledgedPrimeId: "prime-1" });
  expect(await conversationPrimes()).toHaveLength(1);

  // A fresh conversation on another slot whose instruction file is gone (freezing is 11c).
  await rm(join(dir, "factory", "instructions", "builder.md"));
  await connect(() => {}, { ...hello, slotId: "builder-2", launchId: "launch-2", conversationRef: "conv-2" });
  const missing = await daemon.nextAccepted();
  expect(await missing.outcome).toMatchObject({
    _tag: "SourceUnavailable",
    problems: [{ source: "instructions/builder.md", reason: "missing" }],
  });
  await expect(missing.connection.send({ type: "prime", id: "work", text: "x" })).rejects.toThrow(/priming did not complete/);
  expect(await Effect.runPromise(primesForConversation(store, "f1", "builder-2", "conv-2"))).toEqual([]);
  expect((await history()).map((h) => h.kind)).toEqual(["prime.sent"]);
});

test("the prime alone starts no turn; once it is in the session file its receipt is persisted as acknowledgement", async () => {
  const primer = createPrimer({ store, primeRequest, newPrimeId: () => "prime-1" });
  const daemon = await serveDaemon(primer);

  const reporter = new ReceiptReporter();
  let adapter: ConversationAdapter | undefined;
  session = await startFauxSession({
    root: join(dir, "pi"),
    extensionFactories: [(pi) => void (adapter = createConversationAdapter(pi, { onReceipt: reporter.record }))],
  });

  if (!adapter) {throw new Error("conversation adapter not registered");}

  const injected = new Promise<void>((resolve) => {
    const dispatch = receiveDaemonFrames({ adapter: adapter!, interrupter: new RunInterrupter() });
    void connect((frame, channel) => {
      dispatch(frame, channel);
      resolve();
    }).then((channel) => reporter.attach(channel));
  });

  expect(await (await daemon.nextAccepted()).outcome).toMatchObject({ _tag: "Sent" });
  await injected;

  // Injected, but Pi started no turn and has written no session file, so no receipt.
  expect(session.messages.some((m) => m.role === "assistant")).toBe(false);
  expect(session.isStreaming).toBe(false);
  expect(adapter.pending()).toEqual(["prime-1"]);
  expect((await conversationPrimes())[0]?.acknowledgedAt).toBeNull();

  // A first user prompt makes Pi write the session file, prime included.
  const receipt = daemon.nextReceipt();
  await session.prompt("hello");
  // Bounded, so a missing receipt fails on the history assertion below rather than a vitest timeout.
  await Promise.race([receipt, new Promise<void>((r) => setTimeout(r, 2000).unref())]);

  expect((await conversationPrimes())[0]?.acknowledgedAt).toEqual(expect.any(Number));
  expect((await history()).map((h) => [h.kind, h.subject])).toEqual([
    ["prime.sent", "builder-1"],
    ["prime.acknowledged", "builder-1"],
  ]);
  // A repeated receipt changes nothing.
  expect(await primer.receipt({ factoryId: "f1", slotId: "builder-1", launchId: "launch-1" }, "prime-1")).toBe("duplicate");
  expect(await history()).toHaveLength(2);
});

const slot = { factoryId: "f1", slotId: "builder-1", launchId: "launch-1" };

test("the prime is on record before its frame is written, so a sent prime always has a record", async () => {
  const recordedAtSend: Array<ReadonlyArray<string>> = [];

  const stub: AcceptedConnection = {
    send: async () => {
      recordedAtSend.push((await conversationPrimes()).map((p) => p.id));
    },
  };

  const primer = createPrimer({ store, primeRequest, newPrimeId: () => "prime-1" });

  expect(await primer.prime(slot, hello, stub).outcome).toEqual({ _tag: "Sent", primeId: "prime-1" });
  expect(recordedAtSend).toEqual([["prime-1"]]);
});

test("two hellos from one launch send one fresh prime; the reconnect names it while it is unacknowledged", async () => {
  const written: Array<string> = [];
  const stub: AcceptedConnection = { send: async (frame) => void written.push(frame.type === "prime" ? frame.id : frame.type) };
  let n = 0;
  const primer = createPrimer({ store, primeRequest, newPrimeId: () => `prime-${++n}` });

  const outcomes = await Promise.all([primer.prime(slot, hello, stub).outcome, primer.prime(slot, hello, stub).outcome]);

  expect(outcomes).toEqual([
    { _tag: "Sent", primeId: "prime-1" },
    { _tag: "Reconnect", unacknowledgedPrimeId: "prime-1" },
  ]);
  expect(written).toEqual(["prime-1"]);
  expect(await conversationPrimes()).toHaveLength(1);

  await primer.receipt(slot, "prime-1");
  expect(await primer.prime(slot, hello, stub).outcome).toEqual({ _tag: "Reconnect" });
});
