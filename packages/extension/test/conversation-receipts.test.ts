// Tier: integration. One real boundary: Pi 1.6.0's own session persistence,
// run in-process through the SDK with the conversation adapter loaded as an
// inline extension, a temp session dir and the credential-free faux model.
// A process-level `pi` launch would prove nothing more about the receipt rule.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createConversationAdapter } from "@foundry/extension";
import type { ConversationAdapter } from "@foundry/extension";
import { startFauxSession } from "@foundry/testkit";

let root: string;
let session: AgentSession | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foundry-receipts-"));
});

afterEach(async () => {
  session?.dispose();
  session = undefined;
  await rm(root, { recursive: true, force: true });
});

/** A real Pi session whose conversation adapter records every receipt it issues. */
const startWorker = async (): Promise<{ adapter: ConversationAdapter; receipts: Array<string>; session: AgentSession }> => {
  const receipts: Array<string> = [];
  let adapter: ConversationAdapter | undefined;
  session = await startFauxSession({
    root,
    extensionFactories: [(pi) => void (adapter = createConversationAdapter(pi, { onReceipt: (id) => receipts.push(id) }))],
  });

  if (!adapter) {throw new Error("conversation adapter not registered");}

  return { adapter, receipts, session };
};

test("a prime injected into an idle fresh worker gets its receipt only once it is in the session file", async () => {
  const worker = await startWorker();

  worker.adapter.inject({ id: "prime-1", kind: "prime", content: "You are builder-1." });

  // Injected and in Pi's in-memory tree, but Pi has not written a session file yet.
  expect(worker.session.sessionManager.getEntries().some((e) => e.type === "custom_message")).toBe(true);
  expect(existsSync(worker.session.sessionManager.getSessionFile() ?? "")).toBe(false);
  expect(worker.adapter.check()).toEqual([]);
  expect(worker.receipts).toEqual([]);
  expect(worker.adapter.pending()).toEqual(["prime-1"]);
  // The prime alone started no turn.
  expect(worker.session.messages.some((m) => m.role === "assistant")).toBe(false);

  // A user prompt makes Pi write the session file, prime included.
  await worker.session.prompt("hello");

  expect(worker.receipts).toEqual(["prime-1"]);
  expect(worker.adapter.pending()).toEqual([]);
});

test("a message injected once history is on disk is receipted once, and an ID never injected is not", async () => {
  const worker = await startWorker();
  await worker.session.prompt("hello");

  worker.adapter.inject({ id: "msg-1", kind: "message", content: "From planner: start." });
  await worker.session.prompt("again");
  worker.adapter.check();

  expect(worker.receipts).toEqual(["msg-1"]);
  expect(worker.adapter.pending()).toEqual([]);
});
