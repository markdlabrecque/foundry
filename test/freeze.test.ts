// Tier: integration. Real boundaries: the Unix-socket channel between the daemon's server and the
// extension's client, a real SQLite store file, and the management socket driven through the
// `foundry slot unfreeze` core. The Worker Host is a double (its launches are proved by
// slots.test.ts) and the freeze cause's check is a test double: the causes that raise freezes
// arrive with their own tickets. Claim: one frozen slot is sent and launched nothing while the
// other carries on, and unfreeze is refused while its cause persists.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  createPrimer,
  createSlotFreezer,
  createSlotScheduler,
  listOpenHolds,
  openStore,
  planSlots,
  primesForConversation,
  serveManagementApi,
  startChannelServer,
  storeSlotControl,
  storeSlotsReader,
} from "@foundry/daemon";
import type { PrimedConnection, SlotClaim, SlotHost, Store } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import type { LaunchRecord } from "@foundry/host";
import { openChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame, Hello } from "@foundry/protocol";
import { EXIT_OK, EXIT_REFUSED, runSlotList, runSlotUnfreeze } from "@foundry/cli";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const station: EffectiveStation = {
  address: "eng.builder",
  room: "eng",
  station: "builder",
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions: [],
  instances: 2,
  isolation: "none",
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

/** A promise with its resolver, for stepping the journey by hand. */
const signal = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => { resolve = r; });

  return { promise, resolve };
};

/** Bounded, so a missing step fails naming the step rather than as a vitest timeout. */
const within = <A>(step: string, promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${step}`)), 2000).unref(); }),
  ]);

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-freeze-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "factory"), { recursive: true });
  await writeFile(join(dir, "factory", "builder.md"), "You build things.\n");
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store: Store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(dir, "foundry.db") })));

  const slots = planSlots("f1", [station]);
  const launched: Array<string> = [];

  const host: SlotHost = {
    inventory: async () =>
      launched.map((slotId, i): LaunchRecord => ({
        launchId: `launch-${i + 1}`,
        factoryId: "f1",
        slotId,
        pid: 5000 + i,
        pgid: 5000 + i,
        bootId: "boot-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        liveness: "live",
      })),
    launch: async (spec) => {
      launched.push(spec.slotId);

      return {
        launchId: `launch-${launched.length}`,
        factoryId: spec.factoryId,
        slotId: spec.slotId,
        pid: 5000 + launched.length,
        pgid: 5000 + launched.length,
        bootId: "boot-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        liveness: "live",
      };
    },
  };

  const scheduler = createSlotScheduler({
    store,
    stateRoot: dir,
    host,
    hostId: "host-1",
    bootId: "boot-1",
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: "/opt/foundry/extension.js",
    slots,
  });

  return { dir, store, slots, scheduler, launched };
};

test("a frozen slot is sent nothing while the other slot carries on, and stays frozen while its cause persists", async () => {
  const { dir, store, slots, scheduler } = await fixture();
  expect((await scheduler.schedule()).map((r) => [r.slotId, r.outcome])).toEqual([
    ["builder/1", "started"],
    ["builder/2", "started"],
  ]);

  // The cause's check: still failing until the test fixes it.
  let causeFixed = false;

  const freezer = await createSlotFreezer({
    store,
    checks: {
      instruction_missing: async () =>
        causeFixed ? { fixed: true } : { fixed: false, evidence: { missing: "builder.md", checkedAgain: true } },
    },
  });

  await freezer.freeze({ factoryId: "f1", slotId: "builder/1", cause: "instruction_missing", evidence: { missing: "builder.md" } });

  // Scheduling never launches into the frozen slot.
  expect((await scheduler.schedule()).map((r) => [r.slotId, r.outcome])).toEqual([
    ["builder/1", "held"],
    ["builder/2", "running"],
  ]);

  let n = 0;

  const primer = createPrimer({
    store,
    gate: freezer,
    newPrimeId: () => `prime-${++n}`,
    primeRequest: (slot) => ({
      address: "eng.builder",
      slotId: slot.slotId,
      isolation: "none",
      instructions: [join(dir, "factory", "builder.md")],
      knowledgeRoot: join(dir, "knowledge"),
      baseDir: join(dir, "factory"),
    }),
  });

  const accepted = new Map<string, PrimedConnection>();

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot, h, connection) => void accepted.set(slot.slotId, primer.prime(slot, h, connection)),
  });

  cleanups.push(() => server.close());

  const received = new Map<string, Array<string>>([["builder/1", []], ["builder/2", []]]);
  const twoOnSecond = signal();
  const twoOnFirst = signal();

  const connect = async (slotId: string, launchId: string, onSecond: () => void) => {
    const hello: Hello = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      factoryId: "f1",
      slotId,
      launchId,
      conversationRef: `conv-${slotId}`,
      hasRecoverableHistory: false,
      mode: "headless",
      tools: [],
    };

    const opened = await openChannel({
      socketPath: server.socketPath,
      hello,
      heartbeatIntervalMs: 60_000,
      onFrame: (frame: DaemonFrame) => {
        const seen = received.get(slotId)!;
        seen.push(frame.type === "prime" ? frame.id : frame.type);

        if (seen.length === 2) {onSecond();}
      },
    });

    if (!opened.accepted) {throw new Error(`hello for ${slotId} was not accepted`);}

    cleanups.push(() => opened.channel.close());
  };

  await connect("builder/1", "launch-1", twoOnFirst.resolve);
  await connect("builder/2", "launch-2", twoOnSecond.resolve);
  await within("both connections accepted", (async () => {
    while (accepted.size < 2) {
      await new Promise((r) => {
        setTimeout(r, 5);
      });
    }
  })());

  // Work bound to each slot: the frozen slot's stays queued, the other slot's goes out.
  const frozenWork = accepted.get("builder/1")!.connection.send({ type: "prime", id: "work-1", text: "held work" });
  await accepted.get("builder/2")!.connection.send({ type: "prime", id: "work-2", text: "work" });
  await within("the unfrozen slot's prime and work", twoOnSecond.promise);

  expect(received.get("builder/2")).toEqual([expect.stringMatching(/^prime-/), "work-2"]);
  expect(received.get("builder/1")).toEqual([]);
  expect(await run(primesForConversation(store, "f1", "builder/1", "conv-builder/1"))).toEqual([]);

  // The operator's unfreeze is refused while the cause persists; the hold's evidence is refreshed.
  const slotsReader = storeSlotsReader(store, dir, ["f1"], slots);

  const api = await serveManagementApi({
    stateRoot: dir,
    status: () => ({ instance: { stateRoot: dir, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } }),
    slots: slotsReader,
    slotControl: storeSlotControl(slotsReader, freezer),
  });

  cleanups.push(() => api.close());

  const refused = await runSlotUnfreeze({ json: false, home: dir, factory: undefined, slot: "builder/1", env });
  expect(refused.exitCode).toBe(EXIT_REFUSED);
  expect(refused.stderr).toContain("stays frozen: instruction_missing still fails its check");

  const [hold] = await run(listOpenHolds(store));
  expect(hold).toMatchObject({
    kind: "frozen_slot",
    subject: "builder/1",
    evidence: { cause: "instruction_missing", missing: "builder.md", checkedAgain: true },
  });
  expect((await runSlotList({ json: false, home: dir, factory: undefined, env })).stdout).toContain(
    "f1  builder/1  eng.builder  frozen (instruction_missing)",
  );
  expect(received.get("builder/1")).toEqual([]);

  // Once the cause is fixed, unfreeze resolves the hold and the held prime and work go out in order.
  causeFixed = true;
  expect(await runSlotUnfreeze({ json: false, home: dir, factory: undefined, slot: "builder/1", env })).toEqual({
    exitCode: EXIT_OK,
    stdout: `slot builder/1 unfrozen; hold ${hold!.id} resolved\n`,
    stderr: "",
  });
  await frozenWork;
  await within("the unfrozen slot's held prime and work", twoOnFirst.promise);
  expect(received.get("builder/1")).toEqual([expect.stringMatching(/^prime-/), "work-1"]);
  expect(await run(listOpenHolds(store))).toEqual([]);

  // A slot that is not frozen is refused unfreeze.
  const again = await runSlotUnfreeze({ json: false, home: dir, factory: undefined, slot: "builder/1", env });
  expect(again.exitCode).toBe(EXIT_REFUSED);
  expect(again.stderr).toContain("is not frozen");
});

test("a freeze survives a restarted freezer, and a cause with no check is never unfrozen on trust", async () => {
  const { store, scheduler } = await fixture();
  await scheduler.schedule();

  const first = await createSlotFreezer({ store, checks: {} });
  await first.freeze({ factoryId: "f1", slotId: "builder/2", cause: "host_lost", evidence: { launchId: "launch-2" } });
  // Freezing again refreshes the one open hold rather than opening a second.
  await first.freeze({ factoryId: "f1", slotId: "builder/2", cause: "host_lost", evidence: { launchId: "launch-2", again: true } });

  const restarted = await createSlotFreezer({ store, checks: {} });
  expect(restarted.isFrozen({ factoryId: "f1", slotId: "builder/2" })).toBe(true);
  expect(restarted.isFrozen({ factoryId: "f1", slotId: "builder/1" })).toBe(false);
  expect(await restarted.unfreeze({ factoryId: "f1", slotId: "builder/2" })).toEqual({ outcome: "no_check", cause: "host_lost" });
  expect(await run(listOpenHolds(store))).toMatchObject([{ subject: "builder/2", evidence: { cause: "host_lost", again: true } }]);
  expect(await restarted.freeze({ factoryId: "f1", slotId: "nope/1", cause: "host_lost", evidence: {} })).toBe("unknown_slot");
});
