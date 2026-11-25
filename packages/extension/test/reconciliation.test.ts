// Tier: unit. Fake lifecycle and recoverable-history snapshots prove idle rechecks.
import { afterEach, expect, test, vi } from "vitest";
import { MessageReceiver, receiveDaemonFrames } from "@foundry/extension";
import type { OpenChannel } from "@foundry/extension";
import type { WorkerFrame } from "@foundry/protocol";

const fixture = () => {
  let idle = false;
  let status: "history" | "pending" | "absent" = "absent";
  const adapter = { inject: () => {}, pending: () => [], classify: (ids: ReadonlyArray<string>) => ids.map((id) => ({ id, status })) };
  const messages = new MessageReceiver(adapter);
  messages.bind({ isIdle: () => idle });
  const sent: Array<WorkerFrame> = [];
  let close!: () => void;

  const channel: OpenChannel = { send: async (frame) => { sent.push(frame); }, close: () => close(),
    closed: new Promise<void>((resolve) => { close = resolve; }) };

  const receive = receiveDaemonFrames({ adapter, messages, interrupter: { handle: () => {}, handleDrain: () => {} } });

  return { sent, channel, receive, settle: () => { idle = true; }, status: (value: typeof status) => { status = value; } };
};

afterEach(() => vi.useRealTimers());

test.each(["history", "pending", "absent"] as const)("idle recheck takes a fresh %s snapshot rather than reusing working absence", async (status) => {
  vi.useFakeTimers();
  const f = fixture();
  f.receive({ type: "reconcile", requestId: "first", ids: ["id"] }, f.channel);
  expect(f.sent).toEqual([{ type: "reconciliation_answer", requestId: "first", lifecycle: "working", answers: [{ id: "id", status: "absent" }] }]);
  f.receive({ type: "reconcile", requestId: "second", ids: ["id"], whenIdle: true }, f.channel);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.sent).toHaveLength(1);
  f.status(status);
  f.settle();
  await vi.advanceTimersByTimeAsync(25);
  expect(f.sent[1]).toEqual({ type: "reconciliation_answer", requestId: "second", lifecycle: "idle", answers: [{ id: "id", status }] });
  expect(vi.getTimerCount()).toBe(0);
});

test("channel closure cancels the idle recheck without sending a stale answer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.receive({ type: "reconcile", requestId: "second", ids: ["id"], whenIdle: true }, f.channel);
  f.channel.close();
  await f.channel.closed;
  f.settle();
  await vi.advanceTimersByTimeAsync(25);
  expect(f.sent).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
