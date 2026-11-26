// Tier: integration. Controlled local channel peer and real Pi lifecycle/tool error rendering;
// no model credentials or operator state. Timer and commit-ambiguity cases live in client units.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startChannelServer } from "@foundry/daemon";
import { connectWorker } from "@foundry/extension";
import { AGENT_DISCOVER } from "@foundry/protocol";
import type { Hello, HelloRejectReason, DaemonToolOutcome, WorkerFrame } from "@foundry/protocol";
import { startFauxSession } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const fixture = async (reason: HelloRejectReason) => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-worker-refusal-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let dials = 0;
  let toolFrames = 0;

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: {
      claim: async (hello) => {
        dials += 1;

        if (dials === 1) {return { accepted: false, reason };}

        return { accepted: true, slot: { factoryId: hello.factoryId, slotId: hello.slotId, launchId: hello.launchId } };
      },
    },
    onFrame: (_slot, frame) => {
      if (frame.type === "tool_call") {toolFrames += 1;}
    },
  });

  cleanups.push(() => server.close());

  const session = await startFauxSession({
    root: join(dir, "pi"),
    tools: [AGENT_DISCOVER],
    extensionFactories: [(pi) => connectWorker(pi, {
      socketPath: server.socketPath, factoryId: "factory", slotId: "builder/1", launchId: "launch",
    })],
  });

  cleanups.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });

  return { session, dials: () => dials, toolFrames: () => toolFrames };
};

test("terminal hello refusal reaches Pi tools and survives later session starts without redial", async () => {
  const reason = { kind: "terminal", code: "launch_not_current", detail: "the host rejected this launch" } as const;
  const { session, dials, toolFrames } = await fixture(reason);
  await session.prompt(`@@ ${AGENT_DISCOVER} {}`);
  expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
    isError: true,
    content: [{ type: "text", text: `${reason.code}: ${reason.detail}` }],
    details: { status: "refused", code: reason.code, detail: reason.detail },
  });

  await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
  await session.prompt(`@@ ${AGENT_DISCOVER} {}`);
  expect(session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
  expect(session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
    isError: true,
    content: [{ type: "text", text: `${reason.code}: ${reason.detail}` }],
  });
  expect(dials()).toBe(1);
  expect(toolFrames()).toBe(0);
});

test("automatically reconnects the same Pi launch, reconciles known history and replays a lost tool result without a second commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f162-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const hellos: Array<Hello> = [];
  const frames: Array<WorkerFrame> = [];
  const stored = new Map<string, DaemonToolOutcome>();
  let commits = 0;
  let attempts = 0;
  let reconciled!: () => void;
  const reconciliation = new Promise<void>((done) => { reconciled = done; });

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async (hello) => ({ accepted: true, slot: { factoryId: hello.factoryId, slotId: hello.slotId, launchId: hello.launchId } }) },
    onAccepted: (_slot, hello, connection) => {
      hellos.push(hello);

      if (hellos.length === 1) {
        void connection.send({ type: "prime", id: "known-prime", text: "fixture prime" });
      } else {
        void connection.send({ type: "reconcile", requestId: "after-restart", ids: ["known-prime"] });
      }
    },
    onFrame: (_slot, frame) => {
      frames.push(frame);

      if (frame.type === "reconciliation_answer") {reconciled();}
    },
    toolCalls: { submit: async (_slot, call) => {
      attempts += 1;
      const previous = stored.get(call.callId);

      if (previous !== undefined) {return previous;}

      const outcome = { status: "committed", value: { once: ++commits } } as const;
      stored.set(call.callId, outcome);
      // Lose the response after commit. Only the transport goes away, not Pi or its tool client.
      server.revokeSlot("factory", "builder/1");

      return outcome;
    } },
  });

  cleanups.push(() => server.close());

  const session = await startFauxSession({
    root: join(dir, "pi"), tools: [AGENT_DISCOVER],
    extensionFactories: [(pi) => connectWorker(pi, {
      socketPath: server.socketPath, factoryId: "factory", slotId: "builder/1", launchId: "original-launch",
    })],
  });

  cleanups.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  await session.prompt(`@@ ${AGENT_DISCOVER} {}`);
  await reconciliation; // event-driven socket boundary; no sleep/polling assertion
  expect(commits).toBe(1);
  expect(attempts).toBe(2);
  expect(hellos).toHaveLength(2);
  expect(hellos[1]).toMatchObject({ ...hellos[0], hasRecoverableHistory: true });
  expect(frames).toContainEqual({ type: "reconciliation_answer", requestId: "after-restart", lifecycle: "working", answers: [{ id: "known-prime", status: "history" }] });
  expect(session.messages.filter((message) => message.role === "custom")).toHaveLength(1);
  expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({ details: { status: "committed", value: { once: 1 } } });
});

test("retryable hello refusal permits a later session start to dial", async () => {
  const { session, dials } = await fixture({ kind: "retryable", code: "host_unreachable", detail: "try later" });
  expect(dials()).toBe(1);
  await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
  expect(dials()).toBe(2);
});
