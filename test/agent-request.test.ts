// Integration tier: in-process real Pi registration and local channel prove tool wiring only.
// Atomic acceptance and deadlines belong to the daemon's SQLite integration tests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startChannelServer } from "@foundry/daemon";
import { connectWorker } from "@foundry/extension";
import { AGENT_DELEGATE, AGENT_REPLY, AGENT_REQUEST } from "@foundry/protocol";
import type { ToolCall } from "@foundry/protocol";
import { startFauxSession } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

test.each([
  { tool: AGENT_DELEGATE, args: { recipient: "eng.reviewer", body: "Review please", parentDelegationId: "parent-1" },
    value: { delegationId: "delegation-1", rootAssignment: "assignment-1", parentDelegationId: "parent-1", depth: 2, noticeId: "notice-1" } },
  { tool: AGENT_REQUEST, args: { recipient: "eng.reviewer", body: "Review please", timeoutMs: 60_000, delivery: "when_idle" },
    value: { requestId: "request-1", deadline: 1_800_000_060_000 } },
  { tool: AGENT_REPLY, args: { requestId: "request-1", body: "Reviewed" },
    value: { requestId: "request-1", status: "completed", replyId: "reply-1" } },
])("Pi advertises $tool, forwards its arguments and returns the committed result", async ({ tool, args, value }) => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-request-wiring-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls: Array<ToolCall> = [];
  const outcome = { status: "committed", value } as const;

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async (hello) => {
      expect(hello.tools).toContainEqual({ name: tool, source: expect.any(String) });

      return { accepted: true, slot: { factoryId: hello.factoryId, slotId: hello.slotId, launchId: hello.launchId } };
    } },
    toolCalls: { submit: async (_slot, call) => { calls.push(call);

 return outcome; } },
  });

  cleanups.push(() => server.close());

  const session = await startFauxSession({
    root: join(dir, "pi"), tools: [tool],
    extensionFactories: [(pi) => connectWorker(pi, {
      socketPath: server.socketPath, factoryId: "alpha", slotId: "builder/1", launchId: "launch-1",
    })],
  });

  cleanups.push(() => session.dispose());
  await session.prompt(`@@ ${tool} ${JSON.stringify(args)}`);
  expect(calls).toEqual([{ type: "tool_call", callId: expect.any(String), tool, args }]);
  expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
    content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome,
  });
});
