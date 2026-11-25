// Tier: integration. One real boundary: Pi 1.6.0's own session persistence,
// run in-process through the SDK with the conversation adapter loaded as an
// inline extension, a temp session dir and the credential-free faux model.
// A process-level `pi` launch would prove nothing more about the receipt rule.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ConversationAdapter, createConversationAdapter } from "@foundry/extension";
import { FAUX_MODEL, FAUX_PROVIDER, FAUX_PROVIDER_EXTENSION } from "@foundry/testkit";

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
const startWorker = async (): Promise<{ adapter: ConversationAdapter; receipts: string[]; session: AgentSession }> => {
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const receipts: string[] = [];
  let adapter: ConversationAdapter | undefined;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [FAUX_PROVIDER_EXTENSION],
    extensionFactories: [(pi) => void (adapter = createConversationAdapter(pi, { onReceipt: (id) => receipts.push(id) }))],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(root, "sessions")),
    noTools: "all",
  });
  session = created.session;
  await session.bindExtensions({});
  const model = modelRuntime.getModel(FAUX_PROVIDER, FAUX_MODEL);
  if (!model) throw new Error("faux model not registered");
  await session.setModel(model);
  if (!adapter) throw new Error("conversation adapter not registered");
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
