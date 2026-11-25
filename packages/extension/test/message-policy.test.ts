// Tier: unit. Fake Pi lifecycle and injection outcomes prove policy without sessions or sockets.
import { afterEach, expect, test, vi } from "vitest";

import { deliverMessages, interruptRuns, MessageReceiver, receiveDaemonFrames, RunInterrupter } from "@foundry/extension";
import type { ConversationAdapter } from "@foundry/extension";
import type { Message } from "@foundry/protocol";

afterEach(() => vi.useRealTimers());

// Like the interrupt fixture, handlers accept the event/context supplied by each test.
type PiHandler = (...args: Array<any>) => any;

const fixture = (busy = true, deferSettledInjections = false) => {
  const handlers = new Map<string, Array<PiHandler>>();
  const injected: Array<string> = [];
  const state = { busy, emittingSettled: false, disposed: false };
  const deferred: Array<() => Promise<void>> = [];
  const pending = new Set<string>();
  let duringRun: (() => void) | undefined;

  const inject: ConversationAdapter["inject"] = (injection, options) => {
    pending.add(injection.id);
    expect(injection.kind).toBe("message");

    if (deferSettledInjections && state.emittingSettled && options?.triggerTurn) {
      deferred.push(async () => {
        inject(injection, options);
        duringRun?.();
        await settle();
      });

      return;
    }

    injected.push(injection.id);
    pending.delete(injection.id);

    if (options?.triggerTurn) {state.busy = true;}
  };

  const receiver = new MessageReceiver({ inject, pending: () => [...pending] });

  const pi = {
    on: (event: string, handler: PiHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);

      return () => {};
    },
    emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) {
        void handler({}, { isIdle: () => {
          if (state.disposed) {throw new Error("This extension ctx is stale after session replacement or reload.");}

          return !state.busy;
        }, abort: () => {} });
      }
    },
  };

  deliverMessages(pi, receiver);
  pi.emit("session_start");

  const receive = (id: string, delivery: Message["delivery"] = "when_idle") =>
    receiver.receive({ type: "message", id, body: id, delivery });

  // Pi awaits each settle-deferred action, including the run it starts. A run
  // can accept another message and emit a nested settlement before the next action.
  const settle = async () => {
    state.busy = false;
    state.emittingSettled = true;

    for (const handler of handlers.get("agent_settled") ?? []) {await handler({}, {});}

    state.emittingSettled = false;

    for (const action of deferred.splice(0)) {await action();}
  };

  const compact = async () => {
    state.busy = true;

    for (const handler of handlers.get("session_compact") ?? []) {await handler({}, {});}

    state.busy = false;
  };

  return { pi, state, receiver, receive, injected, settle, compact,
    duringRun: (action: () => void) => { duringRun = action; } };
};

test("injection notifications exclude held messages and start only when handed to Pi, once per ID", () => {
  const reported: Array<string> = [];
  const injected: Array<string> = [];
  let idle = false;

  const receiver = new MessageReceiver({
    inject: (message) => { injected.push(message.id); },
    pending: () => [],
  }, (id) => reported.push(id));

  receiver.bind({ isIdle: () => idle });
  receiver.receive({ type: "message", id: "held", body: "held", delivery: "when_idle" });
  expect(reported).toEqual([]);
  receiver.receive({ type: "message", id: "immediate", body: "now", delivery: "after_turn" });
  receiver.receive({ type: "message", id: "immediate", body: "duplicate", delivery: "after_turn" });
  expect(reported).toEqual(["immediate"]);
  idle = true;
  receiver.settled();
  expect(reported).toEqual(["immediate", "held"]);
  expect(injected).toEqual(reported);
  receiver.drain();
});

const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test("working holds when_idle FIFO while after_turn overtakes FIFO; only idle settlement releases the batch once", async () => {
  const { pi, state, receiver, receive, injected } = fixture();
  receive("idle-1");
  receive("turn-1", "after_turn");
  receive("idle-2");
  receive("turn-2", "after_turn");
  receive("idle-1");
  receive("turn-1", "after_turn");
  pi.emit("turn_end");
  pi.emit("agent_end");
  pi.emit("agent_settled"); // A signal alone cannot override Pi still being busy.
  expect(receiver.pending()).toEqual(["idle-1", "idle-2"]);
  expect(injected).toEqual(["turn-1", "turn-2"]);
  state.busy = false;
  pi.emit("agent_settled");
  await tick();
  expect(injected).toEqual(["turn-1", "turn-2", "idle-1", "idle-2"]);
  expect(receiver.pending()).toEqual([]);
  receive("idle-3"); // The released batch has started work again.
  receive("idle-2");
  expect(receiver.pending()).toEqual(["idle-3"]);
  state.busy = false;
  pi.emit("agent_settled");
  await tick();
  expect(injected).toEqual(["turn-1", "turn-2", "idle-1", "idle-2", "idle-3"]);
});

test("an already idle Pi immediately consumes when_idle and starts a turn", () => {
  const { receive, injected, receiver } = fixture(false);
  receive("idle-now");
  expect(injected).toEqual(["idle-now"]);
  expect(receiver.pending()).toEqual([]);
});

test("successful standalone compaction releases held messages only after Pi clears busy", async () => {
  const { pi, state, receive, injected } = fixture();
  receive("held");
  pi.emit("session_compact");
  expect(injected).toEqual([]);
  state.busy = false;
  await tick();
  expect(injected).toEqual(["held"]);
});

test("standalone compaction delivers after a later async handler finishes, without another event", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { pi, receive, injected, compact } = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });

  pi.on("session_compact", () => blocked);
  receive("held");
  const compacting = compact();
  await tick();
  expect(injected).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
  release();
  await compacting;
  await vi.advanceTimersByTimeAsync(25);
  expect(injected).toEqual(["held"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("arrival after an empty compaction check restarts observation until async compaction finishes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { pi, receive, injected, compact } = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });

  pi.on("session_compact", () => blocked);
  const compacting = compact();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
  receive("late-held");
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(injected).toEqual([]);
  release();
  await compacting;
  await vi.advanceTimersByTimeAsync(25);
  expect(injected).toEqual(["late-held"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("draining a busy held queue cancels its observation timer", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { receive, receiver, injected } = fixture();
  receive("held");
  expect(vi.getTimerCount()).toBe(1);
  receiver.drain();
  expect(vi.getTimerCount()).toBe(0);
  expect(receiver.pending()).toEqual(["held"]);
  expect(injected).toEqual([]);
});

test("compaction inside a run cannot release messages; failed or aborted standalone compaction can", async () => {
  const { pi, state, receive, injected } = fixture();
  receive("held");
  pi.emit("session_compact");
  await tick();
  pi.emit("session_compact_failed");
  expect(injected).toEqual([]);
  state.busy = false;
  pi.emit("session_compact_failed");
  await tick();
  expect(injected).toEqual(["held"]);
});


test("settle-deferred runs cannot let a newer when_idle message overtake the older batch", async () => {
  const { receive, injected, settle, duringRun, receiver } = fixture(true, true);
  receive("A");
  receive("B");
  duringRun(() => receive("C"));
  await settle();
  await tick();
  expect(injected).toEqual(["A", "B"]);
  // C would arrive inside A's deferred run with the old implementation,
  // causing A,C,B. Outside the handler the entire batch is injected together.
  receive("C");
  expect(receiver.pending()).toEqual(["C"]);
  await settle();
  await tick();
  expect(injected).toEqual(["A", "B", "C"]);
});

test("an async settlement handler cannot let later messages overtake a deferred batch tail", async () => {
  const { pi, receive, injected, settle, duringRun, receiver } = fixture(true, true);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });

  pi.on("agent_settled", () => blocked);
  receive("A");
  receive("B");
  const settling = settle();
  await tick(); // The receiver flushes while Pi is still awaiting the later handler.
  expect(injected).toEqual(["A"]);
  receive("C"); // Pi appears idle, but B's injection is still deferred.
  expect(receiver.pending()).toEqual(["C"]);
  duringRun(() => receive("D"));
  release();
  await settling;
  await tick();
  expect(injected).toEqual(["A", "B", "C", "D"]);
  expect(receiver.pending()).toEqual([]);
});

test("session shutdown keeps held messages from starting another turn", async () => {
  const { pi, state, receive, injected, receiver } = fixture();
  receive("held");
  pi.emit("session_shutdown");
  state.busy = false;
  pi.emit("agent_settled");
  await tick();
  expect(injected).toEqual([]);
  expect(receiver.pending()).toEqual(["held"]);
});

test("a queued flush cannot use Pi's context after runtime disposal", async () => {
  const { state, receive, injected, settle, receiver } = fixture();
  receive("held");
  await settle();
  state.disposed = true;
  await tick();
  expect(injected).toEqual([]);
  expect(receiver.pending()).toEqual(["held"]);
});

test("drain prevents a scheduled settled flush and acknowledges without starting held work", async () => {
  const { pi, state, receiver, receive, injected } = fixture();
  const interrupter = new RunInterrupter();

  interruptRuns(pi, interrupter);
  pi.emit("session_start");

  const acknowledgements: Array<string> = [];

  const channel = { send: async (frame: { type: string }) => { acknowledgements.push(frame.type); },
    close: () => {}, closed: new Promise<void>(() => {}) };

  const dispatch = receiveDaemonFrames({ adapter: { inject: () => {}, pending: () => [], classify: () => [] }, messages: receiver, interrupter });

  receive("held");
  dispatch({ type: "drain", requestId: "drain-1" }, channel);
  expect(acknowledgements).toEqual([]);
  state.busy = false;
  pi.emit("agent_settled");
  await tick();
  expect(acknowledgements).toEqual(["drain_ack"]);
  expect(injected).toEqual([]);
  expect(receiver.pending()).toEqual(["held"]);
  receive("later");
  pi.emit("agent_settled");
  await tick();
  expect(receiver.pending()).toEqual(["held", "later"]);
  expect(injected).toEqual([]);
});
