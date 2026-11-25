// Journey: the daemon interrupts a real pinned `pi` worker over the channel.
// Proves the wiring Pi's own abort needs (extension context, settle events, a
// live run) that no cheaper tier can: the run is aborted, and the same process
// and conversation carry on without a new launch or hello.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { startChannelServer, type ChannelServer, type SlotClaim } from "@foundry/daemon";
import { type FauxPi, type RpcEvent, startFauxPi } from "@foundry/testkit";
import { BLOCK_TOOL } from "./fixtures/interrupt-worker.js";

const WORKER_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "interrupt-worker.ts");

const acceptAll: SlotClaim = {
  claim: async (h) => ({ accepted: true, slot: { factoryId: h.factoryId, slotId: h.slotId, launchId: h.launchId } }),
};

let pi: FauxPi | undefined;
let server: ChannelServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await pi?.dispose();
  pi = undefined;
  await server?.close();
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const sessionId = async (p: FauxPi, id: string): Promise<unknown> => {
  const reply = p.waitFor((e) => e.type === "response" && e.id === id);
  p.send({ id, type: "get_state" });
  return ((await reply) as RpcEvent & { data: { sessionId: unknown } }).data.sessionId;
};

test("an interrupt aborts the active run and keeps the launch and conversation", async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-interrupt-"));
  const hellos: string[] = [];
  let accepted!: () => void;
  const connected = new Promise<void>((r) => (accepted = r));
  server = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: acceptAll,
    onAccepted: (slot) => {
      hellos.push(slot.launchId);
      accepted();
    },
  });
  pi = startFauxPi({
    extensions: [WORKER_EXTENSION],
    tools: [BLOCK_TOOL],
    env: { FOUNDRY_TEST_CHANNEL_SOCKET: server.socketPath },
  });
  await connected;
  const conversation = await sessionId(pi, "s1");

  // Hold a run active inside a tool that only returns on abort.
  const blocking = pi.waitFor((e) => e.type === "tool_execution_start" && e["toolName"] === BLOCK_TOOL);
  pi.send({ id: "p1", type: "prompt", message: `@@ ${BLOCK_TOOL} {}` });
  await blocking;

  const outcome = await server.interrupt("launch-1");

  expect(outcome).toBe("aborted");
  // Pi runs extension settle handlers (which send the ack) before it writes the RPC event.
  await pi.waitFor((e) => e.type === "agent_settled");
  expect(pi.events.filter((e) => e.type === "agent_settled")).toEqual([{ type: "agent_settled", aborted: true }]);

  // The same process takes the next prompt in the same conversation.
  const next = pi.waitFor((e) => e.type === "agent_settled" && e["aborted"] === false);
  pi.send({ id: "p2", type: "prompt", message: "carry on" });
  await next;
  expect(pi.child.exitCode).toBeNull();
  expect(await sessionId(pi, "s2")).toBe(conversation);
  expect(hellos).toEqual(["launch-1"]);
});
