// Tier: integration. A disposable two-factory fixture exercises discovery over the real channel
// and store with a fake host inventory. One call tests scoping despite caller-supplied args; the
// other goes through Pi's real tool registry and worker extension using the local faux provider.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { agentDiscoverHandler, agentMessageHandler, createHostSlotClaim, createSubmissions, openStore, planSlots, startChannelServer } from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectWorker, openChannel, ToolCallClient } from "@foundry/extension";
import { AGENT_DISCOVER, AGENT_MESSAGE, FIXED_TOOLS, PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
import { startFauxSession } from "@foundry/testkit";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const station = (room: string, name: string, instances: number): EffectiveStation => ({
  address: `${room}.${name}`,
  room,
  station: name,
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions: [],
  instances,
  isolation: "none",
});

const slots = [
  ...planSlots("alpha", [station("eng", "builder", 2), station("qa", "reviewer", 1)]),
  ...planSlots("beta", [station("ops", "deployer", 1), station("eng", "builder", 3)]),
];

const launches = [
  { factoryId: "alpha", slotId: "builder/1", launchId: "alpha-launch", liveness: "live" },
  { factoryId: "beta", slotId: "deployer/1", launchId: "beta-launch", liveness: "live" },
] as const;

const startDiscovery = async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-discover-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store: Store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(dir, "foundry.db") })));

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: createHostSlotClaim({ host: { inventory: async () => launches } }),
    toolCalls: createSubmissions({ store, handlers: new Map([[AGENT_DISCOVER, agentDiscoverHandler(slots)], [AGENT_MESSAGE, agentMessageHandler(slots)]]) }),
  });

  cleanups.push(() => server.close());

  return { dir, socketPath: server.socketPath };
};

const connectAlpha = async (socketPath: string) => {
  const client = new ToolCallClient();
  const { factoryId, slotId, launchId } = launches[0];

  const hello: Hello = {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    factoryId,
    slotId,
    launchId,
    conversationRef: "conv-1",
    hasRecoverableHistory: false,
    mode: "headless",
    tools: [],
  };

  const opened = await openChannel({
    socketPath,
    hello,
    onFrame: (frame) => {
      if (frame.type === "tool_result") {client.receive(frame);}
    },
  });

  if (!opened.accepted) {throw new Error("hello was not accepted");}

  cleanups.push(() => opened.channel.close());
  client.attach(opened.channel);

  return client;
};

test("agent_discover returns the sender factory's configured stations and slots and none of another factory's", async () => {
  const { socketPath } = await startDiscovery();
  const alpha = await connectAlpha(socketPath);
  // Arguments naming another factory change nothing: scope comes from the channel's claim.
  const outcome = await alpha.call("call-1", AGENT_DISCOVER, { factory: "beta" });

  expect(outcome).toEqual({
    status: "committed",
    value: {
      factory: "alpha",
      stations: [
        { address: "eng.builder", room: "eng", station: "builder", slots: ["builder/1", "builder/2"] },
        { address: "qa.reviewer", room: "qa", station: "reviewer", slots: ["reviewer/1"] },
      ],
    },
  });
});

test("Pi can discover its factory and submit a durable message through the registered tools", async () => {
  const { dir, socketPath } = await startDiscovery();

  const session = await startFauxSession({
    root: join(dir, "pi"),
    tools: FIXED_TOOLS,
    extensionFactories: [(pi) => connectWorker(pi, { socketPath, ...launches[1] })],
  });

  cleanups.push(() => session.dispose());
  expect(session.getActiveToolNames()).toEqual(expect.arrayContaining([AGENT_DISCOVER, AGENT_MESSAGE]));
  await session.prompt(`@@ ${AGENT_DISCOVER} {}`);

  const value = {
    factory: "beta",
    stations: [
      { address: "ops.deployer", room: "ops", station: "deployer", slots: ["deployer/1"] },
      { address: "eng.builder", room: "eng", station: "builder", slots: ["builder/1", "builder/2", "builder/3"] },
    ],
  };

  expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
    toolName: AGENT_DISCOVER,
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  });

  await session.prompt(`@@ ${AGENT_MESSAGE} {"recipient":"ops.deployer","body":"Inspect the build.","delivery":"when_idle"}`);

  expect(session.messages.find((message) => message.role === "toolResult" && message.toolName === AGENT_MESSAGE)).toMatchObject({
    toolName: AGENT_MESSAGE,
    details: { status: "committed", value: {
      factoryId: "beta", senderSlot: "deployer/1", recipient: "ops.deployer",
      body: "Inspect the build.", delivery: "when_idle", status: "unbound",
    } },
    isError: false,
  });
});
