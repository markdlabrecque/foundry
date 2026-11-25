// Tier: unit. CompactionReporter against fake channels and a fake Pi; no socket.
// The reconnect journey over the real socket is in test/compaction-report.test.ts.
import { expect, test } from "vitest";
import { CompactionReporter, reportCompactions } from "@foundry/extension";
import type { OpenChannel } from "@foundry/extension";
import type { WorkerFrame } from "@foundry/protocol";

/** A channel that records what it was sent; `fail` makes every send reject while `closed` stays pending. */
const fakeChannel = (fail = false) => {
  const sent: Array<WorkerFrame> = [];
  let attempts = 0;

  const channel: OpenChannel = {
    send: async (frame) => {
      attempts += 1;

      if (fail) {throw new Error("channel is closed");}

      sent.push(frame);
    },
    close: () => {},
    closed: new Promise<void>(() => {}),
  };

  return { channel, sent, attempts: () => attempts };
};

/** Let pending promise callbacks run; a reporter that spins on microtasks never gets past this. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a send that fails before the channel reports closed is kept for the next channel, not retried", async () => {
  const reporter = new CompactionReporter();
  const dying = fakeChannel(true);
  const working = fakeChannel();
  reporter.attach(dying.channel);

  reporter.record();
  await settle();
  reporter.attach(working.channel);
  await settle();

  expect(dying.attempts()).toBe(1);
  expect(working.sent).toEqual([{ type: "compacted" }]);
});

test("only Pi's completed-compaction event is reported", async () => {
  const handlers = new Map<string, () => void>();

  const pi = {
    on: ((event: string, handler: () => void) => {
      handlers.set(event, handler);

      return () => {};
    }) as never,
  };

  const reporter = new CompactionReporter();
  const channel = fakeChannel();
  reporter.attach(channel.channel);
  reportCompactions(pi, reporter);

  for (const event of ["session_before_compact", "session_compact_failed"]) {handlers.get(event)?.();}

  await settle();
  expect(channel.sent).toEqual([]);

  handlers.get("session_compact")?.();
  await settle();
  expect(channel.sent).toEqual([{ type: "compacted" }]);
});
