// Tier: integration. One real boundary: Pi 1.6.0's own tool registry, run in-process
// through the SDK with the launch's `--tools` allowlist and real extension files in a
// temp dir. Pi decides which registrations survive and whom it attributes them to; a
// fake registry would only restate this module's assumptions about that.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registeredToolSet } from "@foundry/extension";
import { AGENT_REPLY, PI_BUILTIN_TOOLS } from "@foundry/protocol";
import { Check } from "typebox/value";
import { connectWorker } from "../src/worker.js";

let root: string;
let session: AgentSession | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foundry-tool-set-"));
});

afterEach(async () => {
  session?.dispose();
  session = undefined;
  await rm(root, { recursive: true, force: true });
});

interface FixtureTool {
  readonly name: string;
  readonly exposure?: "direct" | "hidden" | "deferred" | "codemode";
}

/** Write a plain-JS Pi extension that registers `tools`, and return its path. */
const writeExtension = async (file: string, tools: ReadonlyArray<FixtureTool>): Promise<string> => {
  const path = join(root, "extensions", file);

  const registrations = tools
    .map(
      (tool) => `  pi.registerTool({
    name: ${JSON.stringify(tool.name)},
    label: ${JSON.stringify(tool.name)},
    description: "fixture",
    parameters: { type: "object", properties: {} },
    ${tool.exposure ? `exposure: ${JSON.stringify(tool.exposure)},` : ""}
    async execute() { return { content: [], details: {} }; },
  });`,
    )
    .join("\n");

  await writeFile(path, `export default function (pi) {\n${registrations}\n}\n`);

  return path;
};

/** Start a real Pi session with `extensions` in load order and `allowlist` as `--tools`. */
const reportFrom = async (extensions: ReadonlyArray<string>, allowlist: ReadonlyArray<string>, register?: (pi: ExtensionAPI) => void) => {
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  let foundry: ExtensionAPI | undefined;
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
    additionalExtensionPaths: [...extensions],
    extensionFactories: [(pi) => { foundry = pi; register?.(pi); }],
  });

  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });

  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [...allowlist],
  });

  session = created.session;
  await session.bindExtensions({});

  if (!foundry) {throw new Error("the reporting extension was not loaded");}

  return byName(registeredToolSet(foundry));
};

/** Order-free comparison: the report's order is Pi's, not part of the contract. */
const byName = <T extends { readonly name: string }>(tools: ReadonlyArray<T>): Array<T> =>
  [...tools].sort((a, b) => a.name.localeCompare(b.name));

const builtins = PI_BUILTIN_TOOLS.map((name) => ({ name, source: `builtin:${name}` }));

test("registered agent_reply accepts request and delegation forms, but rejects ambiguous or incomplete resolutions", async () => {
  await reportFrom([], [AGENT_REPLY], (pi) => connectWorker(pi, {
    socketPath: join(root, "unused.sock"), factoryId: "fixture", slotId: "reviewer/1", launchId: "fixture-launch",
  }));
  const tool = session?.getAllTools().find((entry) => entry.name === AGENT_REPLY);

  if (tool === undefined) {throw new Error("agent_reply was not registered");}

  expect(tool.description).toContain("delegationId");
  expect(Check(tool.parameters, { requestId: "request", body: "reviewed" })).toBe(true);
  expect(Check(tool.parameters, { delegationId: "delegation", outcome: "reviewed", evidence: "checks pass" })).toBe(true);

  for (const input of [
    {}, { delegationId: "delegation" }, { delegationId: "delegation", outcome: "reviewed" },
    { delegationId: "delegation", outcome: "", evidence: "checks pass" },
    { delegationId: "delegation", outcome: "reviewed", evidence: "" },
    { requestId: "request", body: "reviewed", delegationId: "delegation", outcome: "reviewed", evidence: "checks pass" },
  ]) {
    expect(Check(tool.parameters, input)).toBe(false);
  }
});

test("reports named tools from configured extensions with their source, and hides the rest", async () => {
  await mkdir(join(root, "extensions"));

  const project = await writeExtension("project.mjs", [
    { name: "web_fetch" },
    { name: "jira_get" }, // registered, but the YAML does not name it
    { name: "vault_peek", exposure: "hidden" }, // named, but Pi keeps it unreachable
    // Naming a deferred or codemode tool in --tools activates it: declared to the model and callable.
    { name: "lazy_lookup", exposure: "deferred" },
    { name: "script_only", exposure: "codemode" },
    // Pi keeps unnamed mcp__ tools registered for tool_search, but never active: not offered.
    { name: "mcp__sneaky" },
  ]);

  const tools = await reportFrom(
    [project],
    [...PI_BUILTIN_TOOLS, "web_fetch", "vault_peek", "lazy_lookup", "script_only"],
  );

  expect(tools).toEqual(
    byName([
      ...builtins,
      { name: "web_fetch", source: project },
      { name: "lazy_lookup", source: project },
      { name: "script_only", source: project },
    ]),
  );
});

test("a reserved or colliding registration is reported under the extension Pi took it from", async () => {
  await mkdir(join(root, "extensions"));
  // Loaded first, so Pi keeps its `web_fetch`; its `read` replaces Pi's own.
  const rogue = await writeExtension("rogue.mjs", [{ name: "read" }, { name: "web_fetch" }]);
  const project = await writeExtension("project.mjs", [{ name: "web_fetch" }]);

  const tools = await reportFrom([rogue, project], [...PI_BUILTIN_TOOLS, "web_fetch"]);

  expect(tools).toEqual(
    byName([
      { name: "read", source: rogue },
      ...builtins.filter((tool) => tool.name !== "read"),
      { name: "web_fetch", source: rogue },
    ]),
  );
});
