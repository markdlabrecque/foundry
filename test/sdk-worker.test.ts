// Integration tier: a real SDK worker launched by the host authenticates on the existing
// channel and executes an allowed tool. All resources and environment are disposable.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { agentDiscoverHandler, createHostSlotClaim, createSubmissions, openStore, startChannelServer } from "@foundry/daemon";
import { buildLaunchArgs, createLaunchRegistry, resolveWorkerExecutable } from "@foundry/host";
import { AGENT_DISCOVER, CHANNEL_SOCKET_ENV, FIXED_TOOLS } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
import { FAUX_MODEL, FAUX_PROVIDER, FAUX_PROVIDER_EXTENSION } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

test("SDK worker preserves explicit resources, host identity and authenticated allowed tool traffic", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundry-sdk-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const slotDir = join(root, "slot");
  const skill = join(root, "skills", "selected", "SKILL.md");

  for (const dir of [home, agentDir, slotDir, join(root, "skills", "selected"), join(agentDir, "extensions")]) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(skill, "---\nname: selected\ndescription: Explicit SDK trial skill\n---\nSelected skill content.\n");
  await writeFile(join(agentDir, "AGENTS.md"), "AMBIENT_CONTEXT_MUST_NOT_LOAD");
  await writeFile(join(agentDir, "SYSTEM.md"), "AMBIENT_SYSTEM_MUST_NOT_LOAD");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["ls"] }));
  const poison = join(agentDir, "poison-loaded");
  await writeFile(join(agentDir, "extensions", "ambient.mjs"), `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(poison)}, 'loaded');`);
  const observed = join(root, "observed.json");
  const finished = join(root, "finished.json");
  const observer = join(root, "observer.mjs");
  await writeFile(observer, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.on('before_agent_start', (event, ctx) => {
    writeFileSync(${JSON.stringify(observed)}, JSON.stringify({model: ctx.model.provider + '/' + ctx.model.id, systemPrompt: event.systemPrompt, tools: pi.getActiveTools()}));
  });
  pi.on('agent_end', (event) => writeFileSync(${JSON.stringify(finished)}, JSON.stringify(event.messages)));
}`);
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(root, "store.db") })));
  const registry = createLaunchRegistry({ bootId: "sdk-test", onExit: () => {} });
  let accepted!: (hello: Hello) => void;

  const helloReceived = new Promise<Hello>((resolve) => { accepted = resolve; });
  let submitted!: () => void;

  const toolSubmitted = new Promise<void>((resolve) => { submitted = resolve; });
  const submissions = createSubmissions({ store, handlers: new Map([[AGENT_DISCOVER, agentDiscoverHandler([])]]) });

  const server = await startChannelServer({
    socketPath: join(root, "channel.sock"),
    slotClaim: createHostSlotClaim({ host: { inventory: async () => registry.inventory() } }),
    onAccepted: (_slot, hello, connection) => {
      accepted(hello);
      void connection.send({ type: "message", id: "sdk-work", body: "@@ agent_discover {}", delivery: "when_idle" });
    },
    toolCalls: { submit: async (slot, call) => {
      const result = await submissions.submit(slot, call);
      submitted();

      return result;
    } },
  });

  cleanups.push(() => server.close());

  const launch = buildLaunchArgs({
    model: `${FAUX_PROVIDER}/${FAUX_MODEL}`,
    skills: [skill],
    extensions: [{ path: FAUX_PROVIDER_EXTENSION, tools: [] }, { path: observer, tools: [] }],
    foundryExtension: new URL("../packages/extension/dist/index.js", import.meta.url).pathname,
    slotDir,
    factoryId: "sdk-factory",
    slotId: "builder/1",
    conversationRef: "sdk-conversation",
  }, resolveWorkerExecutable({ FOUNDRY_WORKER_RUNTIME: "sdk" }));

  const record = await registry.launch({ ...launch, factoryId: "sdk-factory", slotId: "builder/1", env: {
    // Replace ambient home/auth/config discovery. No credential or operator state is used.
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    [CHANNEL_SOCKET_ENV]: server.socketPath,
  } });

  cleanups.push(async () => { await registry.terminate(record.launchId, { graceMs: 1000 }); });
  const hello = await helloReceived;
  expect(hello).toMatchObject({ factoryId: record.factoryId, slotId: record.slotId, launchId: record.launchId, conversationRef: "sdk-conversation", mode: "headless" });
  expect(hello.tools.map((tool) => tool.name).sort()).toEqual([...FIXED_TOOLS].sort());
  expect(hello.tools.find((tool) => tool.name === AGENT_DISCOVER)?.source).toContain("/extension/dist/index.js");
  await toolSubmitted;
  // drain waits for the real model turn and its tool result to settle, not a polling loop.
  await server.drain(record.launchId);
  const observation = JSON.parse(await readFile(observed, "utf8"));
  expect(observation.model).toBe(`${FAUX_PROVIDER}/${FAUX_MODEL}`);
  expect(observation.tools).toEqual(expect.arrayContaining([...FIXED_TOOLS]));
  expect(observation.tools).toHaveLength(FIXED_TOOLS.length);
  expect(observation.systemPrompt).toContain(skill);
  expect(observation.systemPrompt).not.toContain("AMBIENT_");
  await expect(readFile(poison)).rejects.toMatchObject({ code: "ENOENT" });
  const messages = JSON.parse(await readFile(finished, "utf8"));
  expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: AGENT_DISCOVER, isError: false,
    content: [expect.objectContaining({ text: expect.stringContaining('"factory":"sdk-factory"') })] })]));
  expect(registry.inventory()).toMatchObject([{ launchId: record.launchId, liveness: "live" }]);
});
