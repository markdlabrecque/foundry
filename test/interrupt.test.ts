// Tier: integration. One real Unix-socket boundary between the daemon's channel
// server and the extension's channel client. Pi's run control is a test double;
// the journey against a real Pi run is packages/extension/e2e/interrupt.e2e.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ChannelUnavailableError, startChannelServer, type ChannelServer, type SlotClaim } from "@foundry/daemon";
import { openChannel, RunInterrupter, type OpenChannel, type RunControl } from "@foundry/extension";
import { PROTOCOL_VERSION, type Hello, type WorkerFrame } from "@foundry/protocol";

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  factoryId: "f1",
  slotId: "builder-1",
  launchId: "launch-1",
  conversationRef: "conv-1",
  hasRecoverableHistory: true,
  mode: "headless",
  tools: [],
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

/** A Pi run that is active until aborted; abort settles it the way Pi does (idle, then `agent_settled`). */
const fakeRun = (interrupter: RunInterrupter, active: boolean) => {
  let running = active;
  let aborts = 0;
  const control: RunControl = {
    isIdle: () => !running,
    abort: () => {
      aborts += 1;
      setImmediate(() => {
        running = false;
        interrupter.settled(true);
      });
    },
  };
  return { control, aborts: () => aborts };
};

let dir: string;
let server: ChannelServer | undefined;
const channels: OpenChannel[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-interrupt-"));
});

afterEach(async () => {
  for (const channel of channels.splice(0)) channel.close();
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const connect = async (interrupter: RunInterrupter, frames: WorkerFrame[] = []) => {
  let accepted = 0;
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: () => (accepted += 1),
    onFrame: (_slot, frame) => frames.push(frame),
  });
  const opened = await openChannel({
    socketPath: server.socketPath,
    hello,
    heartbeatIntervalMs: 60_000,
    onFrame: (frame, channel) => interrupter.handle(frame, channel),
  });
  if (!opened.accepted) throw new Error("hello was not accepted");
  channels.push(opened.channel);
  return { server, channel: opened.channel, accepted: () => accepted };
};

test("an interrupt aborts the active run once and is acknowledged on the same channel", async () => {
  const interrupter = new RunInterrupter();
  const run = fakeRun(interrupter, true);
  interrupter.bind(run.control);
  const frames: WorkerFrame[] = [];
  const { server, accepted } = await connect(interrupter, frames);

  expect(await server.interrupt("launch-1")).toBe("aborted");
  expect(run.aborts()).toBe(1);
  expect(accepted()).toBe(1);
  expect(frames).toEqual([{ type: "interrupt_ack", requestId: expect.any(String), outcome: "aborted" }]);
});

test("an interrupt with no active run is acknowledged as idle without aborting", async () => {
  const interrupter = new RunInterrupter();
  const run = fakeRun(interrupter, false);
  interrupter.bind(run.control);
  const { server } = await connect(interrupter);

  expect(await server.interrupt("launch-1")).toBe("idle");
  expect(run.aborts()).toBe(0);
});

test("an interrupt for a launch with no accepted channel is refused", async () => {
  server = await startChannelServer({ socketPath: join(dir, "channel.sock"), slotClaim: acceptAll });

  await expect(server.interrupt("launch-1")).rejects.toBeInstanceOf(ChannelUnavailableError);
});

test("an interrupt is refused if the channel is lost before the ack", async () => {
  // Bound but never settles: the run stays active, so no ack is ever sent.
  const interrupter = new RunInterrupter();
  interrupter.bind({ isIdle: () => false, abort: () => {} });
  const { server, channel } = await connect(interrupter);

  const pending = server.interrupt("launch-1");
  channel.close();

  await expect(pending).rejects.toBeInstanceOf(ChannelUnavailableError);
});
