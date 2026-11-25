// Integration tier: in-process real Pi registration and local channel prove tool wiring only.
// Atomic acceptance and deadlines belong to the daemon's SQLite integration tests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startChannelServer } from "@foundry/daemon";
import { connectWorker } from "@foundry/extension";
import { AGENT_REQUEST } from "@foundry/protocol";
import type { ToolCall } from "@foundry/protocol";
import { startFauxSession } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

test("Pi advertises agent_request, forwards its arguments and returns acceptance without a recipient", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-request-wiring-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls: Array<ToolCall> = [];
  const outcome = { status: "committed", value: { requestId: "request-1", deadline: 1_800_000_060_000 } } as const;

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async (hello) => {
      expect(hello.tools).toContainEqual({ name: AGENT_REQUEST, source: expect.any(String) });

      return { accepted: true, slot: { factoryId: hello.factoryId, slotId: hello.slotId, launchId: hello.launchId } };
    } },
    toolCalls: { submit: async (_slot, call) => { calls.push(call);

 return outcome; } },
  });

  cleanups.push(() => server.close());

  const session = await startFauxSession({
    root: join(dir, "pi"), tools: [AGENT_REQUEST],
    extensionFactories: [(pi) => connectWorker(pi, {
      socketPath: server.socketPath, factoryId: "alpha", slotId: "builder/1", launchId: "launch-1",
    })],
  });

  cleanups.push(() => session.dispose());
  const args = { recipient: "eng.reviewer", body: "Review please", timeoutMs: 60_000, delivery: "when_idle" };

  await session.prompt(`@@ ${AGENT_REQUEST} ${JSON.stringify(args)}`);
  expect(calls).toEqual([{ type: "tool_call", callId: expect.any(String), tool: AGENT_REQUEST, args }]);
  expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
    content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome,
  });
});
