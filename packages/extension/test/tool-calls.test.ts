// Tier: unit. ToolCallClient with a hand-fired channel-wait timer and a fake channel; no socket.
// The channel round trip, commit ordering and stored-result replay are in test/tool-calls.test.ts.
import { expect, test } from "vitest";
import { ToolCallClient } from "@foundry/extension";
import type { ChannelWaitTimer, OpenChannel } from "@foundry/extension";
import type { WorkerFrame } from "@foundry/protocol";

/** A channel wait the test expires by hand; it reports how many waits are running. */
const manualTimer = () => {
  const running = new Set<() => void>();

  const timer: ChannelWaitTimer = (_ms, onExpired) => {
    running.add(onExpired);

    return () => void running.delete(onExpired);
  };

  const expire = () => {
    // A snapshot, so expiring one wait never skips or re-runs another.
    for (const onExpired of Array.from(running)) {
      running.delete(onExpired);
      onExpired();
    }
  };

  return { timer, expire, running: () => running.size };
};

/** A channel that records what was written to it and closes when the test says so. */
const fakeChannel = (options: { readonly failWrites?: boolean } = {}) => {
  const sent: Array<WorkerFrame> = [];
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });

  const channel: OpenChannel = {
    send: async (frame) => {
      if (options.failWrites) {throw new Error("channel is closed");}

      sent.push(frame);
    },
    close: () => close(),
    closed,
  };

  return { channel, sent, close };
};

test("a call with no channel within the bounded wait settles as not accepted", async () => {
  const wait = manualTimer();
  const client = new ToolCallClient({ timer: wait.timer });

  const outcome = client.call("call-1", "echo", {});
  wait.expire();

  expect(await outcome).toEqual({ status: "not_accepted", detail: expect.any(String) });
  expect(client.pendingCallIds()).toEqual([]);
});

test("a channel attached within the wait carries the call, and the result settles it", async () => {
  const wait = manualTimer();
  const client = new ToolCallClient({ timer: wait.timer });
  const outcome = client.call("call-1", "echo", { n: 1 });
  const { channel, sent } = fakeChannel();

  client.attach(channel);
  await Promise.resolve();
  client.receive({ type: "tool_result", callId: "call-1", outcome: { status: "committed", value: 1 } });

  expect(await outcome).toEqual({ status: "committed", value: 1 });
  expect(sent).toEqual([{ type: "tool_call", callId: "call-1", tool: "echo", args: { n: 1 } }]);
  expect(wait.running()).toBe(0);
});

test("a call whose channel closes before its result is re-sent with the same call ID on the next channel", async () => {
  const wait = manualTimer();
  const client = new ToolCallClient({ timer: wait.timer });
  const first = fakeChannel();
  client.attach(first.channel);
  const outcome = client.call("call-1", "echo", {});

  first.close();
  await first.channel.closed;
  expect(wait.running()).toBe(1);

  const second = fakeChannel();
  client.attach(second.channel);
  client.receive({ type: "tool_result", callId: "call-1", outcome: { status: "committed", value: null } });

  expect(await outcome).toEqual({ status: "committed", value: null });
  expect(first.sent.map((f) => f.type === "tool_call" && f.callId)).toEqual(["call-1"]);
  expect(second.sent.map((f) => f.type === "tool_call" && f.callId)).toEqual(["call-1"]);
});

test("a call whose write fails waits for another channel and settles as not accepted when none comes", async () => {
  const wait = manualTimer();
  const client = new ToolCallClient({ timer: wait.timer });
  client.attach(fakeChannel({ failWrites: true }).channel);

  const outcome = client.call("call-1", "echo", {});
  await Promise.resolve();
  await Promise.resolve();
  wait.expire();

  expect(await outcome).toEqual({ status: "not_accepted", detail: expect.any(String) });
});

test("a repeated call ID while the first is pending shares one send and one outcome", async () => {
  const client = new ToolCallClient({ timer: manualTimer().timer });
  const { channel, sent } = fakeChannel();
  client.attach(channel);

  const first = client.call("call-1", "echo", {});
  const again = client.call("call-1", "echo", {});
  client.receive({ type: "tool_result", callId: "call-1", outcome: { status: "committed", value: 2 } });

  expect(await Promise.all([first, again])).toEqual([
    { status: "committed", value: 2 },
    { status: "committed", value: 2 },
  ]);
  expect(sent).toHaveLength(1);
});
