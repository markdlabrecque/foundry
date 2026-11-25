// Tier: integration. Real boundaries: the Unix-socket channel between the
// daemon's server and the extension's client, a real SQLite store file, and
// Pi 1.6.0's own session run in-process with the faux model, so the prime's
// place in the conversation is Pi's real tool-round boundary. The slot claim is
// a test double. Pi's compaction event is fired through the extension's real
// reporter by hand: that `session_compact` fires mid-run is FOU-28's evidence,
// and the faux model cannot script around a real summarization pass.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { Type } from "typebox";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { composePrime, createPrimer, openStore, primesForConversation, startChannelServer } from "@foundry/daemon";
import type { AcceptedConnection, ChannelServer, CompactionPrimingOutcome, PrimedConnection, PrimeRequest, SlotClaim, Store } from "@foundry/daemon";
import { CompactionReporter, createConversationAdapter, openChannel, receiveDaemonFrames, RunInterrupter } from "@foundry/extension";
import type { ConversationAdapter, OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
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
  tools: [{ name: "fixture_gate", source: "test" }],
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

const GATE_TOOL = "fixture_gate";

let dir: string;
let scope: Scope.Closeable;
let store: Store;
let server: ChannelServer | undefined;
let session: AgentSession | undefined;
const channels: Array<OpenChannel> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-compaction-prime-"));
  await mkdir(join(dir, "factory", "instructions"), { recursive: true });
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
  instructions: [join(dir, "factory", "instructions", "builder.md")],
  knowledgeRoot: join(dir, "knowledge"),
  baseDir: join(dir, "factory"),
});

/** A promise with its resolver, for stepping the journey by hand. */
const signal = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => (resolve = r));

  return { promise, resolve };
};

/** Bounded, so a missing step fails naming the step rather than as a vitest timeout. */
const within = <A>(step: string, promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${step}`)), 2000).unref()),
  ]);

const conversationPrimes = () => Effect.runPromise(primesForConversation(store, "f1", "builder-1", "conv-1"));

test("a compaction prime reaches the same launch's conversation at the next tool-round boundary, ahead of held work", async () => {
  // Composition of the compaction prime is held open, so work is queued while it is being prepared.
  const composing = signal();
  const releaseCompose = signal();
  let n = 0;

  const primer = createPrimer({
    store,
    primeRequest,
    newPrimeId: () => `prime-${++n}`,
    compose: async (request) => {
      if (request.situation === "compaction") {
        composing.resolve();
        await releaseCompose.promise;
      }

      return composePrime(request);
    },
  });

  const accepted: Array<PrimedConnection> = [];
  const lost: Array<string> = [];
  // Wrapped, so the signal settles when the frame arrives rather than adopting the outcome promise.
  const compaction = signal<{ readonly outcome: Promise<CompactionPrimingOutcome> }>();
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot, h, connection) => void accepted.push(primer.prime(slot, h, connection)),
    onFrame: (slot, frame) => {
      if (frame.type === "compacted") {compaction.resolve({ outcome: primer.compacted(slot) });}
    },
    onChannelLost: (slot) => void lost.push(slot.launchId),
  });

  // The worker: a real Pi session with the conversation adapter and a tool round that waits to be released.
  const toolRunning = signal();
  const releaseTool = signal();
  let adapter: ConversationAdapter | undefined;
  session = await startFauxSession({
    root: join(dir, "pi"),
    tools: [GATE_TOOL],
    extensionFactories: [
      (pi) => {
        adapter = createConversationAdapter(pi, { onReceipt: () => {} });
        pi.registerTool({
          name: GATE_TOOL,
          label: "Fixture gate",
          description: "Test fixture: wait until released.",
          parameters: Type.Object({}),
          async execute() {
            toolRunning.resolve();
            await releaseTool.promise;

            return { content: [{ type: "text", text: "released" }], details: {} };
          },
        });
      },
    ],
  });

  if (!adapter) {throw new Error("conversation adapter not registered");}

  const delivered: Array<string> = [];
  const deliveredWaiters: Array<{ count: number; resolve: () => void }> = [];
  const dispatch = receiveDaemonFrames({ adapter, interrupter: new RunInterrupter() });

  const opened = await openChannel({
    socketPath: server.socketPath,
    hello,
    heartbeatIntervalMs: 60_000,
    onFrame: (frame, channel) => {
      dispatch(frame, channel);
      delivered.push(frame.type === "prime" ? frame.id : frame.type);

      for (const w of deliveredWaiters.filter((w) => delivered.length >= w.count)) {w.resolve();}
    },
  });

  if (!opened.accepted) {throw new Error("hello was not accepted");}

  channels.push(opened.channel);

  const deliveredCount = (count: number) =>
    new Promise<void>((resolve) => (delivered.length >= count ? resolve() : deliveredWaiters.push({ count, resolve })));

  const reporter = new CompactionReporter();
  reporter.attach(opened.channel);

  await within("the fresh prime", deliveredCount(1));
  const [primed] = accepted;
  expect(await primed!.outcome).toEqual({ _tag: "Sent", primeId: "prime-1" });

  const sessionId = session.sessionManager.getSessionId();
  // A run is mid-tool-round when Pi compacts.
  const run = session.prompt(`@@ ${GATE_TOOL} {}`);
  await within("the tool round", toolRunning.promise);
  reporter.record();
  const { outcome: compacted } = await within("the compacted report", compaction.promise);
  await within("compaction prime composition", composing.promise);

  // Work sent while the compaction prime is being prepared is held behind it.
  // (A prime frame stands in for a message, which arrives in later tickets.)
  const work = primed!.connection.send({ type: "prime", id: "work-1", text: "Held work." });
  releaseCompose.resolve();
  expect(await within("the compaction prime outcome", compacted)).toEqual({ _tag: "Sent", primeId: "prime-2" });
  await within("the held work write", work);
  await within("delivery of both frames", deliveredCount(3));

  // Both arrived while Pi was still inside the tool round; nothing is in the conversation yet.
  expect(session.isStreaming).toBe(true);
  releaseTool.resolve();
  await run;

  // On the wire: the compaction prime went ahead of the held work.
  expect(delivered).toEqual(["prime-1", "prime-2", "work-1"]);

  // In the conversation: after the tool round's result and before the next assistant response.
  const entries = session.sessionManager.getEntries().flatMap((e) => {
    if (e.type === "custom_message") {return [`foundry:${(e.details as { foundryId: string }).foundryId}`];}

    // Pi's own system-prompt entries are not part of the ordering under test.
    if (e.type === "message" && e.message.role !== "system") {return [e.message.role];}

    return [];
  });

  expect(entries).toEqual(["foundry:prime-1", "user", "assistant", "toolResult", "foundry:prime-2", "foundry:work-1", "assistant"]);

  // The launch identity is unchanged: one connection, never lost, and both primes on the same launch and conversation.
  expect(session.sessionManager.getSessionId()).toBe(sessionId);
  expect(accepted).toHaveLength(1);
  expect(lost).toEqual([]);
  expect((await conversationPrimes()).map((p) => [p.id, p.situation, p.launchId, p.conversationRef])).toEqual([
    ["prime-1", "fresh", "launch-1", "conv-1"],
    ["prime-2", "compaction", "launch-1", "conv-1"],
  ]);
});

test("a compaction report from a launch with no primed connection sends and records nothing", async () => {
  const written: Array<string> = [];
  const stub: AcceptedConnection = { send: async (frame) => void written.push(frame.type) };
  const primer = createPrimer({ store, primeRequest, newPrimeId: () => "prime-1" });
  const slot = { factoryId: "f1", slotId: "builder-1", launchId: "launch-1" };

  expect(await primer.compacted(slot)).toEqual({ _tag: "NotConnected" });
  await primer.prime(slot, hello, stub).outcome;
  expect(await primer.compacted({ ...slot, launchId: "launch-2" })).toEqual({ _tag: "NotConnected" });

  expect(written).toEqual(["prime"]);
  expect((await conversationPrimes()).map((p) => p.situation)).toEqual(["fresh"]);
});
