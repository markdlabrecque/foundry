// Tier: unit. RunInterrupter wired to a fake Pi through interruptRuns; no socket.
// The channel round trip is in test/interrupt.test.ts, the real Pi journey in e2e.
import { expect, test } from "vitest";
import { interruptRuns, RunInterrupter } from "@foundry/extension";
import type { RunControl } from "@foundry/extension";

/** A stand-in for Pi's extension API: records handlers so the test can fire Pi's events. */
const fakePi = () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();

  return {
    on: ((event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);

      return () => {};
    }) as never,
    emit: (event: string, payload: unknown = {}, ctx: unknown = undefined) =>
      (handlers.get(event) ?? []).forEach((h) => h(payload, ctx)),
  };
};

/** Pi with some work in progress; `busy` is flipped by the test to mirror Pi's state. */
const busyPi = () => {
  const pi = fakePi();
  const state = { busy: true };
  const control: RunControl = { isIdle: () => !state.busy, abort: () => {} };
  const interrupter = new RunInterrupter();
  interruptRuns(pi, interrupter);
  pi.emit("session_start", { reason: "startup" }, control);

  return { pi, state, interrupter };
};

const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const track = <T>(promise: Promise<T>) => {
  const seen: { value?: T } = {};
  void promise.then((value) => (seen.value = value));

  return seen;
};

test("a standalone compaction that completes despite the abort is acknowledged once Pi clears it", async () => {
  const { pi, state, interrupter } = busyPi();
  const outcome = track(interrupter.interrupt());

  // Pi emits session_compact while still compacting, and clears that state right after.
  pi.emit("session_compact");
  state.busy = false;
  await tick();
  await tick();

  expect(outcome.value).toBe("idle");
});

test("a compaction ending inside a run does not acknowledge before the run settles", async () => {
  const { pi, state, interrupter } = busyPi();
  const outcome = track(interrupter.interrupt());

  pi.emit("session_compact");
  await tick();
  await tick();
  expect(outcome.value).toBeUndefined();

  state.busy = false;
  pi.emit("agent_settled", { aborted: true });
  await tick();

  expect(outcome.value).toBe("aborted");
});
