// Tier: integration. One real Unix-socket boundary between the daemon's channel
// server and the extension's channel client; the slot claim and lapse timer are
// test doubles so the heartbeat lapse needs no wall-clock waits.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startChannelServer } from "@foundry/daemon";
import type { ChannelLostCause, ChannelServer, ClaimedSlot, LapseTimer, SlotClaim } from "@foundry/daemon";
import { openChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello, HelloRejectReason, WorkerFrame } from "@foundry/protocol";

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  factoryId: "f1",
  slotId: "builder-1",
  launchId: "launch-1",
  conversationRef: "conv-1",
  hasRecoverableHistory: false,
  mode: "headless",
  tools: [{ name: "read", source: "pi" }],
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

/** A lapse timer the test fires by hand; it also counts how often it was (re-)armed. */
const manualTimer = () => {
  let pending: (() => void) | undefined;
  let arms = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  const timer: LapseTimer = (_ms, onLapse) => {
    arms += 1;
    pending = onLapse;

    for (const w of waiters.filter((w) => arms >= w.count)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }

    return () => {
      if (pending === onLapse) {pending = undefined;}
    };
  };

  /** Resolves once the deadline has been armed at least `count` times. */
  const armed = (count: number): Promise<void> =>
    arms >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve }));

  return { timer, fire: () => pending?.(), arms: () => arms, armed };
};

const waitFor = <T>(register: (resolve: (value: T) => void) => void): Promise<T> => new Promise(register);

/** Send raw lines and collect every line the daemon sends back until it closes the connection. */
const rawExchange = (socketPath: string, lines: Array<string>): Promise<Array<unknown>> =>
  new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(lines.join("")));
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("error", reject);
    socket.on("close", () =>
      resolve(received.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown)),
    );
  });

let dir: string;
let server: ChannelServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-channel-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("a valid hello is accepted, and heartbeats arrive attributed to the claimed slot", async () => {
  const frames: Array<[ClaimedSlot, WorkerFrame]> = [];
  let gotHeartbeat!: () => void;
  const heartbeat = waitFor<void>((r) => (gotHeartbeat = r));
  const claimed: Array<Hello> = [];
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: {
      claim: async (h) => {
        claimed.push(h);

        // The claim decides the slot; the connection speaks for it, whatever the frames say.
        return { accepted: true, slot: { factoryId: "f1", slotId: "authorized-slot", launchId: "launch-1" } };
      },
    },
    onFrame: (slot, frame) => {
      frames.push([slot, frame]);
      gotHeartbeat();
    },
  });

  expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);

  const opened = await openChannel({ socketPath: server.socketPath, hello, heartbeatIntervalMs: 1 });
  expect(opened.accepted).toBe(true);
  await heartbeat;

  if (opened.accepted) {opened.channel.close();}

  expect(claimed).toEqual([hello]);
  expect(frames[0]).toEqual([{ factoryId: "f1", slotId: "authorized-slot", launchId: "launch-1" }, { type: "heartbeat" }]);
});

test.each([
  ["a version mismatch", { ...hello, protocolVersion: PROTOCOL_VERSION + 1 }, "protocol_version_mismatch"],
  ["a missing launch ID", { ...hello, launchId: undefined }, "malformed_hello"],
  ["a non-JSON line", "not json", "malformed_hello"],
  ["a heartbeat before hello", { type: "heartbeat" }, "hello_required"],
])("%s is rejected with a terminal reason and never reaches the slot claim or slot work", async (_name, first, code) => {
  let claims = 0;
  const frames: Array<WorkerFrame> = [];
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async (h) => (claims++, acceptAll.claim(h)) },
    onFrame: (_slot, frame) => frames.push(frame),
  });

  const firstLine = typeof first === "string" ? `${first}\n` : `${JSON.stringify(first)}\n`;
  const replies = await rawExchange(server.socketPath, [firstLine, `${JSON.stringify({ type: "heartbeat" })}\n`]);

  expect(replies).toEqual([{ type: "hello_rejected", reason: expect.objectContaining({ kind: "terminal", code }) }]);
  expect(claims).toBe(0);
  expect(frames).toEqual([]);
});

test("a refused slot claim is relayed to the worker and its later frames reach no slot work", async () => {
  const reason: HelloRejectReason = { kind: "retryable", code: "host_unreachable", detail: "host did not answer" };
  const frames: Array<WorkerFrame> = [];
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async () => ({ accepted: false, reason }) },
    onFrame: (_slot, frame) => frames.push(frame),
  });

  const replies = await rawExchange(server.socketPath, [
    `${JSON.stringify(hello)}\n`,
    `${JSON.stringify({ type: "heartbeat" })}\n`,
  ]);

  const viaClient = await openChannel({ socketPath: server.socketPath, hello });

  expect(replies).toEqual([{ type: "hello_rejected", reason }]);
  expect(viaClient).toEqual({ accepted: false, reason });
  expect(frames).toEqual([]);
});

test("a connection that never sends a hello is dropped on the lapse deadline without reporting a slot", async () => {
  const lapse = manualTimer();
  const lost: Array<ClaimedSlot> = [];
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    lapseTimer: lapse.timer,
    onChannelLost: (slot) => lost.push(slot),
  });

  const socket = connect(server.socketPath);
  const closed = waitFor<void>((r) => socket.on("close", () => r()));
  socket.on("error", () => {});
  await waitFor<void>((r) => socket.on("connect", () => r()));
  // The server arms the deadline when it accepts the connection; wait until it has.
  await lapse.armed(1);

  lapse.fire();

  await closed;
  expect(lost).toEqual([]);
});

test("a heartbeat lapse reports only channel loss and closes the connection", async () => {
  const lapse = manualTimer();
  let lost!: (value: [ClaimedSlot, ChannelLostCause]) => void;
  const channelLost = waitFor<[ClaimedSlot, ChannelLostCause]>((r) => (lost = r));
  let gotHeartbeat!: () => void;
  const heartbeat = waitFor<void>((r) => (gotHeartbeat = r));
  let armsAtAccept = -1;
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    lapseTimer: lapse.timer,
    onAccepted: () => (armsAtAccept = lapse.arms()),
    onFrame: () => gotHeartbeat(),
    onChannelLost: (slot, cause) => lost([slot, cause]),
  });

  // A heartbeat after acceptance must push the deadline back; then the worker goes silent.
  const opened = await openChannel({ socketPath: server.socketPath, hello, heartbeatIntervalMs: 1 });

  if (!opened.accepted) {throw new Error("hello was not accepted");}

  await heartbeat;
  expect(armsAtAccept).toBeGreaterThan(0);
  expect(lapse.arms()).toBeGreaterThan(armsAtAccept);

  lapse.fire();

  expect(await channelLost).toEqual([{ factoryId: "f1", slotId: "builder-1", launchId: "launch-1" }, "heartbeat_lapse"]);
  await opened.channel.closed;
});

test("a slot claim that throws is refused as retryable", async () => {
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async () => { throw new Error("host gone"); } },
  });

  const opened = await openChannel({ socketPath: server.socketPath, hello });

  expect(opened).toEqual({
    accepted: false,
    reason: expect.objectContaining({ kind: "retryable", code: "slot_claim_failed" }),
  });
});

test.each([
  ["an invalid frame after acceptance", `${JSON.stringify({ type: "bogus" })}\n`],
  ["an oversize line after acceptance", "x".repeat(1024 * 1024 + 1)],
])("%s closes the connection as a protocol error", async (_name, payload) => {
  let lost!: (cause: ChannelLostCause) => void;
  const channelLost = waitFor<ChannelLostCause>((r) => (lost = r));
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onChannelLost: (_slot, cause) => lost(cause),
  });

  const socket = connect(server.socketPath);
  socket.on("error", () => {});
  const closed = waitFor<void>((r) => socket.on("close", () => r()));
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify(hello)}\n`);
  await waitFor<void>((r) => socket.once("data", () => r()));
  socket.write(payload);

  expect(await channelLost).toBe("protocol_error");
  await closed;
});
