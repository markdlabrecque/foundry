// Tier: integration. Real Pi persistence and tool-round boundary, credential-free faux model.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Type } from "typebox";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createConversationAdapter, deliverMessages, MessageReceiver } from "@foundry/extension";
import { startFauxSession } from "@foundry/testkit";

let root: string;
let session: AgentSession | undefined;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "foundry-message-policy-")); });

afterEach(async () => {
  session?.dispose();
  session = undefined;
  await rm(root, { recursive: true, force: true });
});

test("after_turn starts an idle Pi turn and receipts only recoverable history", async () => {
  let receiver: MessageReceiver | undefined;
  const receipts: Array<string> = [];
  let settled!: () => void;
  const completed = new Promise<void>((resolve) => { settled = resolve; });
  session = await startFauxSession({ root, extensionFactories: [(pi) => {
    receiver = new MessageReceiver(createConversationAdapter(pi, { onReceipt: (id) => receipts.push(id) }));
    pi.on("agent_settled", () => settled());
  }] });

  if (receiver === undefined) {throw new Error("fixture receiver not registered");}

  expect(receipts).toEqual([]);
  expect(session.messages).toEqual([]);
  receiver.receive({ type: "message", id: "immediate", body: "Act now", delivery: "after_turn" });
  receiver.receive({ type: "message", id: "immediate", body: "Act now", delivery: "after_turn" });
  await completed;
  expect(receipts).toEqual(["immediate"]);
  expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
  expect(session.messages.some((message) => message.role === "assistant")).toBe(true);
});

test("after_turn overtakes held messages at the tool boundary; when_idle batch follows on settlement in recoverable FIFO order", async () => {
  let receiver: MessageReceiver | undefined;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const toolEntered = new Promise<void>((resolve) => { entered = resolve; });
  let settled!: () => void;
  const heldCompleted = new Promise<void>((resolve) => { settled = resolve; });
  const receipts: Array<string> = [];

  session = await startFauxSession({ root, tools: ["wait_fixture"], extensionFactories: [(pi) => {
    receiver = new MessageReceiver(createConversationAdapter(pi, { onReceipt: (id) => receipts.push(id) }));
    deliverMessages(pi, receiver);
    pi.on("agent_settled", () => {
      if (receipts.includes("held-2")) {settled();}
    });
    pi.registerTool({ name: "wait_fixture", label: "Wait", description: "Disposable tool barrier", parameters: Type.Object({}),
      async execute() {
        entered();
        await blocked;

        return { content: [{ type: "text", text: "released" }], details: {} };
      } });
  }] });
  const run = session.prompt('@@ wait_fixture {}');
  await toolEntered;

  if (receiver === undefined) {throw new Error("fixture receiver not registered");}

  receiver.receive({ type: "message", id: "held-1", body: "Held first", delivery: "when_idle" });
  receiver.receive({ type: "message", id: "held-2", body: "Held second", delivery: "when_idle" });
  receiver.receive({ type: "message", id: "first", body: "First", delivery: "after_turn" });
  receiver.receive({ type: "message", id: "second", body: "Second", delivery: "after_turn" });
  expect(receipts).toEqual([]);
  expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
  release();
  await run;
  await heldCompleted;
  expect(receipts).toEqual(["first", "second", "held-1", "held-2"]);
  expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")
    .map((entry) => entry.content)).toEqual(["First", "Second", "Held first", "Held second"]);
});
