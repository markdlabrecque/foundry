// Tier: integration. One real Unix-socket channel between the daemon's server
// and the extension's client, authorized by the host-confirmed slot claim. The
// Worker Host's reports are a controlled double: the real host's inventory is
// proven by the host's own integration test, and these cases need reports the
// real host cannot be made to give on demand (a foreign slot, a failed answer).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHostSlotClaim, startChannelServer } from "@foundry/daemon";
import type { ChannelServer, ClaimedSlot, LaunchInventory, SlotClaim } from "@foundry/daemon";
import { openChannel } from "@foundry/extension";
import type { ChannelOpenResult } from "@foundry/extension";
import type { HostConnection, LaunchRecord } from "@foundry/host";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello, WorkerFrame } from "@foundry/protocol";

const live = (launchId: string, slotId = "builder-1"): LaunchRecord => ({
  launchId,
  factoryId: "f1",
  slotId,
  pid: 4242,
  pgid: 4242,
  bootId: "boot-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  liveness: "live",
});

const gone = (launchId: string): LaunchRecord => ({
  ...live(launchId),
  liveness: "gone",
  exit: { code: 0, signal: null, endedAt: "2026-01-01T00:01:00.000Z" },
});

const hello = (overrides: Partial<Hello> = {}): Hello => ({
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  factoryId: "f1",
  slotId: "builder-1",
  launchId: "launch-2",
  conversationRef: "conv-1",
  hasRecoverableHistory: false,
  mode: "headless",
  tools: [],
  ...overrides,
});

// Compile-time only: the real host connection fits the claim's inventory seam.
const _hostConnectionIsInventory = (connection: HostConnection): LaunchInventory => connection;

void _hostConnectionIsInventory;

/** Host reports the test controls. The real `connectHost` connection satisfies the same seam. */
const reports = (launches: ReadonlyArray<LaunchRecord>): LaunchInventory => ({ inventory: async () => launches });

let dir: string;
let server: ChannelServer | undefined;
const opened: Array<ChannelOpenResult> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-slot-claim-"));
});

afterEach(async () => {
  for (const result of opened.splice(0)) {if (result.accepted) {result.channel.close();}}

  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const serve = async (slotClaim: SlotClaim, onFrame?: (slot: ClaimedSlot, frame: WorkerFrame) => void) => {
  server = await startChannelServer({ socketPath: join(dir, "channel.sock"), slotClaim, ...(onFrame && { onFrame }) });

  return server;
};

const say = async (socketPath: string, h: Hello): Promise<ChannelOpenResult> => {
  const result = await openChannel({ socketPath, hello: h, heartbeatIntervalMs: 1 });
  opened.push(result);

  return result;
};

test("a hello from the slot's current launch is accepted and its frames speak for the host's record", async () => {
  // The slot's earlier launch is gone; launch-2 is its current one.
  const claim = createHostSlotClaim({ host: reports([gone("launch-1"), live("launch-2")]) });
  let attributed!: (slot: ClaimedSlot) => void;
  const firstFrame = new Promise<ClaimedSlot>((resolve) => (attributed = resolve));
  const { socketPath } = await serve(claim, (slot) => attributed(slot));

  const result = await say(socketPath, hello());

  expect(result.accepted).toBe(true);
  expect(await firstFrame).toEqual({ factoryId: "f1", slotId: "builder-1", launchId: "launch-2" });
});

test.each([
  ["a stale launch the host reports gone", [gone("launch-1"), live("launch-2")], hello({ launchId: "launch-1" }), "launch_stale"],
  ["a launch the host has in another slot", [live("launch-2", "builder-2")], hello(), "launch_identity_conflict"],
  ["a launch the host has in another factory", [live("launch-2")], hello({ factoryId: "f2" }), "launch_identity_conflict"],
  ["a launch the host does not know", [live("launch-2")], hello({ launchId: "launch-9" }), "launch_unknown"],
])("%s is refused terminally and reaches no slot work", async (_name, launches, claimed, code) => {
  const frames: Array<WorkerFrame> = [];
  const { socketPath } = await serve(createHostSlotClaim({ host: reports(launches) }), (_slot, f) => frames.push(f));

  const result = await say(socketPath, claimed);

  expect(result).toEqual({ accepted: false, reason: expect.objectContaining({ kind: "terminal", code }) });
  expect(frames).toEqual([]);
});

test("a reconnect with an unchanged conversation is accepted; a changed conversation is refused", async () => {
  const { socketPath } = await serve(createHostSlotClaim({ host: reports([live("launch-2")]) }));

  const first = await say(socketPath, hello());

  if (first.accepted) {first.channel.close();}

  const reconnect = await say(socketPath, hello());
  const changed = await say(socketPath, hello({ conversationRef: "conv-2" }));

  expect(first.accepted).toBe(true);
  expect(reconnect.accepted).toBe(true);
  expect(changed).toEqual({
    accepted: false,
    reason: expect.objectContaining({ kind: "terminal", code: "conversation_changed" }),
  });
});

test("a host that cannot answer gets a retryable refusal", async () => {
  const host: LaunchInventory = { inventory: async () => { throw new Error("host gone"); } };
  const { socketPath } = await serve(createHostSlotClaim({ host }));

  const result = await say(socketPath, hello());

  expect(result).toEqual({
    accepted: false,
    reason: expect.objectContaining({ kind: "retryable", code: "host_unreachable" }),
  });
});
