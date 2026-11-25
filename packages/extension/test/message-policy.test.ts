// Tier: unit. Fake Pi lifecycle and injection outcomes prove policy without sessions or sockets.
import { expect, test } from "vitest";
import { deliverMessages, interruptRuns, MessageReceiver, receiveDaemonFrames, RunInterrupter } from "@foundry/extension";
import type { ConversationAdapter } from "@foundry/extension";
import type { Message } from "@foundry/protocol";

// Like the interrupt fixture, handlers accept the event/context supplied by each test.
type PiHandler = (...args: Array<any>) => void;

const fixture = (busy = true, deferSettledInjections = false) => {
  const handlers = new Map<string, Array<PiHandler>>();
  const injected: Array<string> = [];
  const state = { busy, emittingSettled: false, disposed: false };
  const deferred: Array<() => Promise<void>> = [];
  let duringRun: (() => void) | undefined;

  const inject: ConversationAdapter["inject"] = (injection, options) => {
    expect(options).toEqual({ triggerTurn: true });
    expect(injection.kind).toBe("message");

    if (deferSettledInjections && state.emittingSettled) {
      deferred.push(async () => {
        inject(injection, options);
        duringRun?.();
        await settle();
      });

      return;
    }

    injected.push(injection.id);
    state.busy = true;
  };

  const receiver = new MessageReceiver({ inject });

  const pi = {
    on: (event: string, handler: PiHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);

      return () => {};
    },
    emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) {
        handler({}, { isIdle: () => {
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
    pi.emit("agent_settled");
    state.emittingSettled = false;

    for (const action of deferred.splice(0)) {await action();}
  };

  return { pi, state, receiver, receive, injected, settle,
    duringRun: (action: () => void) => { duringRun = action; } };
};

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

  const dispatch = receiveDaemonFrames({ adapter: { inject: () => {} }, messages: receiver, interrupter });

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
