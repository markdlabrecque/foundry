// Tier: integration. Real boundaries: the Unix-socket channel, the slot claim that attributes a
// call to its factory, the submission dispatcher and a real SQLite store file. Configuration is a
// disposable two-factory fixture. Claim: `agent_discover` answers with the sender's configured
// stations and slots and nothing of another factory's, whatever the call's arguments say.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { AGENT_DISCOVER, agentDiscoverHandler, createSubmissions, openStore, planSlots, startChannelServer } from "@foundry/daemon";
import type { SlotClaim, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import { openChannel, ToolCallClient } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";

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

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

/** Bounded, so a missing result fails naming it rather than as a vitest timeout. */
const within = <A>(step: string, promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${step}`)), 2000).unref(); }),
  ]);

const workerOf = async (factoryId: string, slotId: string) => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-discover-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store: Store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(dir, "foundry.db") })));

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    toolCalls: createSubmissions({ store, handlers: new Map([[AGENT_DISCOVER, agentDiscoverHandler(slots)]]) }),
  });

  cleanups.push(() => server.close());

  const client = new ToolCallClient({ timer: () => () => {} });

  const hello: Hello = {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    factoryId,
    slotId,
    launchId: `${factoryId}-launch`,
    conversationRef: "conv-1",
    hasRecoverableHistory: false,
    mode: "headless",
    tools: [],
  };

  const opened = await openChannel({
    socketPath: server.socketPath,
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
  const alpha = await workerOf("alpha", "builder/1");
  // Arguments naming another factory change nothing: scope comes from the channel's claim.
  const outcome = await within("the result", alpha.call("call-1", AGENT_DISCOVER, { factory: "beta" }));

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

test("a worker of the other factory discovers only its own, even where station names coincide", async () => {
  const beta = await workerOf("beta", "deployer/1");
  const outcome = await within("the result", beta.call("call-1", AGENT_DISCOVER, {}));

  expect(outcome).toEqual({
    status: "committed",
    value: {
      factory: "beta",
      stations: [
        { address: "ops.deployer", room: "ops", station: "deployer", slots: ["deployer/1"] },
        { address: "eng.builder", room: "eng", station: "builder", slots: ["builder/1", "builder/2", "builder/3"] },
      ],
    },
  });
});
