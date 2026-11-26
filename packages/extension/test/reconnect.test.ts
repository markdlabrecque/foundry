// Tier: unit. Controlled clocks and dial outcomes, no Pi, sockets or sleeps.
import { afterEach, expect, test, vi } from "vitest";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
import type { OpenChannel, ChannelOpenResult, OpenChannelOptions } from "../src/channel/client.js";
import { WorkerConnection } from "../src/channel/lifecycle.js";
import { CompactionReporter } from "../src/compaction.js";
import { ReceiptReporter } from "../src/priming.js";

const hello = (): Hello => ({ type: "hello", protocolVersion: PROTOCOL_VERSION, factoryId: "factory", slotId: "builder/1", launchId: "launch", conversationRef: "conversation", hasRecoverableHistory: false, mode: "headless", tools: [] });

const channel = () => {
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });

  return { send: async () => {}, close: vi.fn(() => close()), closed } satisfies OpenChannel;
};

const fixture = (dial: (options: OpenChannelOptions) => Promise<ChannelOpenResult>) => {
  vi.useFakeTimers();
  const attached: Array<OpenChannel> = [];
  const refuse = vi.fn();
  const onFrame = vi.fn();
  const connection = new WorkerConnection({ socketPath: "unused", dial, onFrame, attach: (c) => attached.push(c), refuse, failed: () => {} });

  return { connection, attached, refuse, onFrame };
};

afterEach(() => vi.useRealTimers());

test("retryable hello refusal retries without another session event", async () => {
  const accepted = channel();
  const reason = { kind: "retryable", code: "host_unreachable", detail: "try later" } as const;

  const dial = vi.fn<NonNullable<ConstructorParameters<typeof WorkerConnection>[0]["dial"]>>()
    .mockResolvedValueOnce({ accepted: false, reason })
    .mockResolvedValue({ accepted: true, channel: accepted });

  const f = fixture(dial);
  await f.connection.start(hello);
  expect(f.refuse).toHaveBeenCalledWith(reason);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.attached).toEqual([accepted]);
  f.connection.stop();
});

test("terminal refusal permanently latches across later session events", async () => {
  const reason = { kind: "terminal", code: "launch_not_current", detail: "stale launch" } as const;
  const dial = vi.fn(async (): Promise<ChannelOpenResult> => ({ accepted: false, reason }));
  const f = fixture(dial);
  await f.connection.start(hello);
  await f.connection.start(hello);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(dial).toHaveBeenCalledTimes(1);
  expect(f.refuse).toHaveBeenCalledWith(reason);
  expect(vi.getTimerCount()).toBe(0);
});

test("shutdown cancels a scheduled retry and cannot be revived by a session event", async () => {
  const dial = vi.fn(async (): Promise<ChannelOpenResult> => { throw new Error("offline"); });
  const f = fixture(dial);
  await f.connection.start(hello);
  f.connection.stop();
  await f.connection.start(hello);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(dial).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["shutdown", "replacement"])("%s cancels an in-flight dial and discards its late acceptance and frames", async (action) => {
  const late = channel();
  const current = channel();
  let resolve!: (result: ChannelOpenResult) => void;
  const pending = new Promise<ChannelOpenResult>((done) => { resolve = done; });
  const attempts: Array<OpenChannelOptions> = [];

  const f = fixture(async (options) => {
    attempts.push(options);

    return attempts.length === 1 ? pending : { accepted: true, channel: current };
  });

  const start = f.connection.start(hello);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(1); // no retry while hello is outstanding

  if (action === "shutdown") {f.connection.stop();} else {await f.connection.start(hello);}

  expect(attempts[0]?.signal?.aborted).toBe(true);
  attempts[0]?.onFrame?.({ type: "reconcile", requestId: "obsolete", ids: [] }, late);
  expect(f.onFrame).not.toHaveBeenCalled();
  resolve({ accepted: true, channel: late });
  await start;
  expect(late.close).toHaveBeenCalledOnce();
  expect(f.attached).toEqual(action === "shutdown" ? [] : [current]);
  expect(vi.getTimerCount()).toBe(0);
  f.connection.stop();
});

test("each retry observes current conversation/history/tools, while session replacement cancels stale retries", async () => {
  let observation = hello();
  const observations: Array<Hello> = [];
  const first = channel();
  const second = channel();

  const f = fixture(async (options) => {
    observations.push(options.hello);

    if (observations.length === 1) {throw new Error("offline");}

    return { accepted: true, channel: observations.length === 2 ? first : second };
  });

  await f.connection.start(() => observation);
  observation = { ...observation, hasRecoverableHistory: true, tools: [{ name: "read", source: "builtin:read" }] };
  await vi.advanceTimersByTimeAsync(250);
  expect(observations[1]).toEqual(observation);
  observation = { ...observation, conversationRef: "changed-conversation", tools: [] };
  await f.connection.start(() => observation);
  expect(first.close).toHaveBeenCalledOnce();
  expect(observations[2]).toEqual(observation); // never disguise a conversation change
  await first.closed;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(observations).toHaveLength(3);
  f.connection.stop();
});

test.each(["receipt", "compaction"])("pending %s flushes on reconnect even when the old write fails after attach", async (kind) => {
  let reject!: (cause: Error) => void;
  const dying = { ...channel(), send: () => new Promise<void>((_done, failed) => { reject = failed; }) };
  const working = { ...channel(), send: vi.fn(async () => {}) };
  const receipts = new ReceiptReporter();
  const compactions = new CompactionReporter();
  receipts.attach(dying);
  compactions.attach(dying);

  if (kind === "receipt") {receipts.record("known-receipt");} else {compactions.record();}

  receipts.attach(working);
  compactions.attach(working);
  reject(new Error("old channel lost"));
  await Promise.resolve();
  await Promise.resolve();
  expect(working.send.mock.calls).toEqual([[kind === "receipt" ? { type: "receipt", id: "known-receipt" } : { type: "compacted" }]]);
});

test("initial transport unavailability retries automatically with bounded backoff then reconnects after loss", async () => {
  let ready = false;
  const first = channel();
  const second = channel();
  let accepts = 0;

  const dial = vi.fn(async (): Promise<ChannelOpenResult> => {
    if (!ready) {throw new Error("daemon unavailable");}

    return { accepted: true, channel: accepts++ === 0 ? first : second };
  });

  const f = fixture(dial);
  await f.connection.start(hello);

  for (const ms of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
    expect(vi.getTimerCount()).toBe(1);
    const before = dial.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(dial).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(dial).toHaveBeenCalledTimes(before + 1);
  }

  ready = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.attached).toEqual([first]);
  expect(vi.getTimerCount()).toBe(0);
  first.close();
  await first.closed;
  await vi.advanceTimersByTimeAsync(250);
  expect(f.attached).toEqual([first, second]);
  f.connection.stop();
  expect(second.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(vi.getTimerCount()).toBe(0);
});
