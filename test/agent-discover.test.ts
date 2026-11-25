// Tier: integration. Disposable two-factory state proves authenticated discovery/status and
// durable snapshot replay at the channel/store boundary, plus real Pi tool-registration wiring.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { agentDiscoverHandler, agentMessageHandler, agentStatusHandler, createHostSlotClaim, createSubmissions, openStore, planSlots, startChannelServer } from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { connectWorker, openChannel, ToolCallClient } from "@foundry/extension";
import { AGENT_DISCOVER, AGENT_MESSAGE, AGENT_STATUS, FIXED_TOOLS, PROTOCOL_VERSION } from "@foundry/protocol";
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
    toolCalls: createSubmissions({ store, handlers: new Map([
      [AGENT_DISCOVER, agentDiscoverHandler(slots)],
      [AGENT_STATUS, agentStatusHandler(slots)],
      [AGENT_MESSAGE, agentMessageHandler(slots)],
    ]) }),
  });

  cleanups.push(() => server.close());

  return { dir, socketPath: server.socketPath, store };
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

test("agent_status reports capacity and non-eligible slots, scopes observations, and replays its committed snapshot", async () => {
  const { socketPath, store } = await startDiscovery();
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    for (const slot of slots) {
      yield* change.query(
        `INSERT INTO slot (factory_id, slot_id, station, ordinal, condition, freeze_cause)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [slot.factoryId, slot.slotId, slot.station.address, slot.ordinal,
          slot.slotId === "builder/2" ? "frozen" : "normal",
          slot.slotId === "builder/2" ? "host_lost" : null],
      );
    }

    yield* change.query(
      `INSERT INTO launch (launch_id, factory_id, slot_id, boot_id, pid, started_at, origin)
       VALUES ('alpha-launch', 'alpha', 'builder/1', 'test-boot', 123, 1, 'started')`,
    );
    yield* change.query(`UPDATE slot SET current_launch = 'alpha-launch' WHERE factory_id = 'alpha' AND slot_id = 'builder/1'`);
    yield* change.recordHistory({ factoryId: "alpha", kind: "test.setup", subject: "slots" });
  })));
  const alpha = await connectAlpha(socketPath);
  // Both arguments and same-named slots in beta must not redirect the authenticated scope.
  const outcome = await alpha.call("status-1", AGENT_STATUS, { factory: "beta", slot: "deployer/1" });

  expect(outcome).toEqual({
    status: "committed",
    value: {
      factory: "alpha",
      stations: [
        { address: "eng.builder", capacity: 2, slots: [
          { slotId: "builder/1", condition: "normal", freezeCause: null, recordedLaunch: "unended" },
          { slotId: "builder/2", condition: "frozen", freezeCause: "host_lost", recordedLaunch: "none" },
        ] },
        { address: "qa.reviewer", capacity: 1, slots: [
          { slotId: "reviewer/1", condition: "normal", freezeCause: null, recordedLaunch: "none" },
        ] },
      ],
    },
  });

  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(
    `UPDATE slot SET condition = 'normal', freeze_cause = NULL WHERE factory_id = 'alpha' AND slot_id = 'builder/2'`,
    );
    yield* change.recordHistory({ factoryId: "alpha", kind: "test.unfreeze", subject: "builder/2" });
  })));
  expect(await alpha.call("status-1", AGENT_STATUS, {})).toEqual(outcome);
  expect(await alpha.call("status-2", AGENT_STATUS, {})).not.toEqual(outcome);

  const records = await Effect.runPromise(store.read<{ call_id: string }>(
    `SELECT call_id FROM submission WHERE tool = ? ORDER BY call_id`, [AGENT_STATUS],
  ));

  expect(records).toEqual([{ call_id: "status-1" }, { call_id: "status-2" }]);
});

test("Pi can discover and inspect its factory and submit a durable message through registered tools", async () => {
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

  expect(session.getActiveToolNames()).toContain(AGENT_STATUS);
  await session.prompt(`@@ ${AGENT_STATUS} {}`);
  expect(session.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
    toolName: AGENT_STATUS,
    content: [{ type: "text", text: JSON.stringify({
      factory: "beta",
      stations: [
        { address: "ops.deployer", capacity: 1, slots: [{ slotId: "deployer/1", condition: "unknown", freezeCause: null, recordedLaunch: "none" }] },
        { address: "eng.builder", capacity: 3, slots: [1, 2, 3].map((ordinal) => ({ slotId: `builder/${ordinal}`, condition: "unknown", freezeCause: null, recordedLaunch: "none" })) },
      ],
    }) }],
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
