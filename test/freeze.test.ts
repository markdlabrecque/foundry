// Tier: integration. Real boundaries: the Unix-socket channel between the daemon's server and the
// extension's client, a real SQLite store file, and the management socket driven through the
// `foundry slot unfreeze` core, and (in the missing-instruction test) real prime composition and
// its unfreeze check reading instruction files from a temp fixture. The Worker Host is a double
// (its launches are proved by slots.test.ts); elsewhere the freeze cause's check is a test double.
// Claims: one frozen slot is sent and launched nothing while the other carries on, unfreeze is
// refused while its cause persists, and an instruction file missing at priming freezes the slot
// until the file is restored and the operator unfreezes.
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  composePrime,
  createPrimer,
  createSlotFreezer,
  createSlotScheduler,
  instructionFilesCheck,
  listOpenHolds,
  openStore,
  planSlots,
  primesForConversation,
  PrimingOutcome,
  serveManagementApi,
  startChannelServer,
  storeSlotControl,
  storeSlotsReader,
} from "@foundry/daemon";
import type { AcceptedConnection, FreezeRequest, PrimedConnection, SlotClaim, SlotGate, SlotHost, SlotRef, Store } from "@foundry/daemon";
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
    freezer: await createSlotFreezer({ store, checks: {} }),
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
  const bothAccepted = signal();

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot, h, connection) => {
      accepted.set(slot.slotId, primer.prime(slot, h, connection));

      if (accepted.size === 2) {bothAccepted.resolve();}
    },
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
  await within("both connections accepted", bothAccepted.promise);

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

test("a connection that ends while its slot is frozen is never primed; the live launch is, once unfrozen", async () => {
  const { dir, store, scheduler } = await fixture();
  await scheduler.schedule();
  const freezer = await createSlotFreezer({ store, checks: { host_lost: async () => ({ fixed: true }) } });
  await freezer.freeze({ factoryId: "f1", slotId: "builder/1", cause: "host_lost", evidence: { launchId: "launch-1" } });

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

  const accepted: Array<PrimedConnection> = [];
  const waiters: Array<(c: PrimedConnection) => void> = [];

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot, h, connection) => {
      const primed = primer.prime(slot, h, connection);
      accepted.push(primed);
      waiters.shift()?.(primed);
    },
  });

  cleanups.push(() => server.close());

  const nextAccepted = (): Promise<PrimedConnection> =>
    new Promise((resolve) => {
      const ready = accepted.shift();

      if (ready === undefined) {waiters.push(resolve);}
      else {resolve(ready);}
    });

  const connect = async (launchId: string, onPrime: (id: string) => void) => {
    const opened = await openChannel({
      socketPath: server.socketPath,
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        factoryId: "f1",
        slotId: "builder/1",
        launchId,
        conversationRef: "conv-builder/1",
        hasRecoverableHistory: false,
        mode: "headless",
        tools: [],
      },
      heartbeatIntervalMs: 60_000,
      onFrame: (frame: DaemonFrame) => {
        if (frame.type === "prime") {onPrime(frame.id);}
      },
    });

    if (!opened.accepted) {throw new Error(`hello for ${launchId} was not accepted`);}

    cleanups.push(() => opened.channel.close());

    return opened.channel;
  };

  const stale = await connect("launch-1", () => {});
  const first = await within("the first connection accepted", nextAccepted());
  stale.close();
  expect(await within("the closed connection's priming", first.outcome)).toEqual(PrimingOutcome.Closed());

  const primed = signal<string>();
  await connect("launch-3", primed.resolve);
  const second = await within("the second connection accepted", nextAccepted());

  expect(await freezer.unfreeze({ factoryId: "f1", slotId: "builder/1" })).toMatchObject({ outcome: "unfrozen" });
  expect(await within("the live launch's prime", second.outcome)).toEqual(PrimingOutcome.Sent({ primeId: "prime-1" }));
  expect(await within("the prime on the wire", primed.promise)).toBe("prime-1");
  expect(await run(primesForConversation(store, "f1", "builder/1", "conv-builder/1"))).toMatchObject([
    { id: "prime-1", launchId: "launch-3" },
  ]);
});

test("a slot frozen while its prime is being composed gets the prime only once unfrozen", async () => {
  const { dir, store, scheduler } = await fixture();
  await scheduler.schedule();
  const freezer = await createSlotFreezer({ store, checks: { host_lost: async () => ({ fixed: true }) } });
  const slot = { factoryId: "f1", slotId: "builder/1" };

  // The primer's writer registers the first unfreeze listener; a send waiting on the gate registers the second.
  const waitingToSend = signal();
  let registrations = 0;

  const gate: SlotGate = {
    isFrozen: (s) => freezer.isFrozen(s),
    onUnfrozen: (listener) => {
      registrations += 1;

      if (registrations === 2) {waitingToSend.resolve();}

      return freezer.onUnfrozen(listener);
    },
  };

  const primer = createPrimer({
    store,
    gate,
    newPrimeId: () => "prime-1",
    compose: async (request) => {
      await freezer.freeze({ ...slot, cause: "host_lost", evidence: { launchId: "launch-1" } });

      return composePrime(request);
    },
    primeRequest: () => ({
      address: "eng.builder",
      slotId: "builder/1",
      isolation: "none",
      instructions: [join(dir, "factory", "builder.md")],
      knowledgeRoot: join(dir, "knowledge"),
      baseDir: join(dir, "factory"),
    }),
  });

  // Each write notes whether the slot was frozen at that moment.
  const written: Array<{ readonly id: string; readonly frozen: boolean }> = [];

  const connection: AcceptedConnection = {
    send: async (frame) => void written.push({ id: frame.type === "prime" ? frame.id : frame.type, frozen: freezer.isFrozen(slot) }),
    closed: new Promise<void>(() => {}),
  };

  const hello: Hello = {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    factoryId: "f1",
    slotId: "builder/1",
    launchId: "launch-1",
    conversationRef: "conv-builder/1",
    hasRecoverableHistory: false,
    mode: "headless",
    tools: [],
  };

  const primed = primer.prime({ ...slot, launchId: "launch-1" }, hello, connection);
  await within("the recorded prime waiting on the frozen slot", waitingToSend.promise);
  expect(written).toEqual([]);

  expect(await freezer.unfreeze(slot)).toMatchObject({ outcome: "unfrozen" });
  expect(await within("the prime after unfreeze", primed.outcome)).toEqual(PrimingOutcome.Sent({ primeId: "prime-1" }));
  expect(written).toEqual([{ id: "prime-1", frozen: false }]);
});

test("an instruction file missing at priming freezes the slot, and no work goes out until it is restored and unfrozen", async () => {
  const { dir, store, slots, scheduler } = await fixture();
  await scheduler.schedule();
  const builder = join(dir, "factory", "builder.md");

  const primeRequest = (slot: SlotRef) => ({
    address: "eng.builder",
    slotId: slot.slotId,
    isolation: "none" as const,
    instructions: [builder],
    knowledgeRoot: join(dir, "knowledge"),
    baseDir: join(dir, "factory"),
  });

  const freezer = await createSlotFreezer({ store, checks: { instruction_missing: instructionFilesCheck(primeRequest) } });
  const frozen = signal<FreezeRequest>();
  let n = 0;

  const primer = createPrimer({
    store,
    gate: freezer,
    freeze: async (request) => {
      const outcome = await freezer.freeze(request);
      frozen.resolve(request);

      return outcome;
    },
    newPrimeId: () => `prime-${++n}`,
    primeRequest,
  });

  const accepted = signal<PrimedConnection>();

  const server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot, h, connection) => accepted.resolve(primer.prime(slot, h, connection)),
  });

  cleanups.push(() => server.close());

  // The file passed validation at load; it goes missing before the slot's first prime.
  await rename(builder, `${builder}.away`);

  const received: Array<string> = [];
  const primeAndWork = signal();

  const opened = await openChannel({
    socketPath: server.socketPath,
    hello: {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      factoryId: "f1",
      slotId: "builder/1",
      launchId: "launch-1",
      conversationRef: "conv-builder/1",
      hasRecoverableHistory: false,
      mode: "headless",
      tools: [],
    },
    heartbeatIntervalMs: 60_000,
    onFrame: (frame: DaemonFrame) => {
      received.push(frame.type === "prime" ? frame.id : frame.type);

      if (received.length === 2) {primeAndWork.resolve();}
    },
  });

  if (!opened.accepted) {throw new Error("hello was not accepted");}

  cleanups.push(() => opened.channel.close());

  const primed = await within("the connection accepted", accepted.promise);
  const work = primed.connection.send({ type: "prime", id: "work-1", text: "held work" });
  await within("the slot frozen for its missing file", frozen.promise);

  // The hold names the missing file; nothing was sent or recorded as a prime.
  const [hold] = await run(listOpenHolds(store));
  expect(hold).toMatchObject({
    kind: "frozen_slot",
    subject: "builder/1",
    evidence: { cause: "instruction_missing", missing: ["builder.md"], problems: [{ source: "builder.md", reason: "missing" }] },
  });
  expect(received).toEqual([]);
  expect(await run(primesForConversation(store, "f1", "builder/1", "conv-builder/1"))).toEqual([]);

  const slotsReader = storeSlotsReader(store, dir, ["f1"], slots);

  const api = await serveManagementApi({
    stateRoot: dir,
    status: () => ({ instance: { stateRoot: dir, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } }),
    slots: slotsReader,
    slotControl: storeSlotControl(slotsReader, freezer),
  });

  cleanups.push(() => api.close());

  // Unfreezing before the file is back re-runs the check and stays frozen.
  const refused = await runSlotUnfreeze({ json: false, home: dir, factory: undefined, slot: "builder/1", env });
  expect(refused.exitCode).toBe(EXIT_REFUSED);
  expect(refused.stderr).toContain("stays frozen: instruction_missing still fails its check");
  expect(received).toEqual([]);

  // Restoring the file alone sends nothing: the operator's unfreeze is what releases the slot.
  await rename(`${builder}.away`, builder);
  expect(received).toEqual([]);
  expect(freezer.isFrozen({ factoryId: "f1", slotId: "builder/1" })).toBe(true);

  expect(await runSlotUnfreeze({ json: false, home: dir, factory: undefined, slot: "builder/1", env })).toEqual({
    exitCode: EXIT_OK,
    stdout: `slot builder/1 unfrozen; hold ${hold!.id} resolved\n`,
    stderr: "",
  });
  expect(await within("the prime after unfreeze", primed.outcome)).toEqual(PrimingOutcome.Sent({ primeId: "prime-1" }));
  await work;
  await within("the prime and held work on the wire", primeAndWork.promise);
  expect(received).toEqual(["prime-1", "work-1"]);
  expect(await run(primesForConversation(store, "f1", "builder/1", "conv-builder/1"))).toMatchObject([
    { id: "prime-1", situation: "fresh", parts: [{ source: "builder.md" }] },
  ]);
  expect(await run(listOpenHolds(store))).toEqual([]);
});
