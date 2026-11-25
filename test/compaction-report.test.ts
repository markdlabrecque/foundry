// Tier: integration. One real Unix-socket boundary between the daemon's channel
// server and the extension's channel client. Pi is a test double that only
// records the extension's handlers, so the compaction event is fired by hand.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startChannelServer } from "@foundry/daemon";
import type { ChannelServer, SlotClaim } from "@foundry/daemon";
import { CompactionReporter, openChannel, reportCompactions } from "@foundry/extension";
import type { OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello, WorkerFrame } from "@foundry/protocol";

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  factoryId: "f1",
  slotId: "builder-1",
  launchId: "launch-1",
  conversationRef: "conv-1",
  hasRecoverableHistory: true,
  mode: "headless",
  tools: [{ name: "read", source: "pi" }],
};

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

/** A stand-in for Pi's extension API that lets the test fire registered events. */
const fakePi = () => {
  const handlers = new Map<string, Array<() => void>>();

  return {
    on: ((event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);

      return () => {};
    }) as never,
    emit: (event: string) => (handlers.get(event) ?? []).forEach((h) => h()),
  };
};

let dir: string;
let server: ChannelServer | undefined;
const channels: Array<OpenChannel> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-compaction-"));
});

afterEach(async () => {
  for (const channel of channels.splice(0)) {channel.close();}

  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("compactions while the channel is down are reported exactly once after reconnect", async () => {
  // Each connection's frames, closed out when the daemon sees the connection end.
  const connections: Array<Array<WorkerFrame>> = [];
  const ended: Array<() => void> = [];
  const endedWaits: Array<Promise<void>> = [];
  const compactedSeen: Array<() => void> = [];
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: () => {
      connections.push([]);
    },
    onFrame: (_slot, frame) => {
      connections.at(-1)?.push(frame);

      if (frame.type === "compacted") {compactedSeen.shift()?.();}
    },
    onChannelLost: () => ended.shift()?.(),
  });

  const nextEnd = () => {
    const wait = new Promise<void>((r) => ended.push(r));
    endedWaits.push(wait);

    return wait;
  };

  const open = async (): Promise<OpenChannel> => {
    const opened = await openChannel({ socketPath: server!.socketPath, hello, heartbeatIntervalMs: 60_000 });

    if (!opened.accepted) {throw new Error("hello was not accepted");}

    channels.push(opened.channel);

    return opened.channel;
  };

  const pi = fakePi();
  const reporter = new CompactionReporter();
  reportCompactions(pi, reporter);

  // Connected, then the channel drops.
  const first = await open();
  reporter.attach(first);
  const firstEnded = nextEnd();
  first.close();
  await first.closed;
  await firstEnded;

  // Pi compacts twice while the channel is down; events that are not a completed compaction report nothing.
  pi.emit("session_before_compact");
  pi.emit("session_compact");
  pi.emit("session_compact_failed");
  pi.emit("session_compact");

  // Reconnect: the held report goes out on the new channel.
  const reported = new Promise<void>((r) => compactedSeen.push(r));
  const second = await open();
  reporter.attach(second);
  // Bounded, so a missing report fails on the frame diff below rather than a vitest timeout.
  await Promise.race([reported, new Promise<void>((r) => setTimeout(r, 2000).unref())]);

  // Closing flushes the stream in order, so every frame sent before it has arrived.
  const secondEnded = nextEnd();
  second.close();
  await secondEnded;

  expect(connections).toEqual([[], [{ type: "compacted" }]]);
});
