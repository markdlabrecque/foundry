// Tier: unit. Fake Pi lifecycle and injection outcomes prove policy without sessions or sockets.
import { expect, test } from "vitest";
import { deliverMessages, MessageReceiver } from "@foundry/extension";
import type { ConversationAdapter } from "@foundry/extension";
import type { Message } from "@foundry/protocol";

// Like the interrupt fixture, handlers accept the event/context supplied by each test.
type PiHandler = (...args: Array<any>) => void;

const fixture = (busy = true) => {
  const handlers = new Map<string, Array<PiHandler>>();
  const injected: Array<string> = [];
  const state = { busy };

  const receiver = new MessageReceiver({ inject: (injection, options) => {
    expect(options).toEqual({ triggerTurn: true });
    expect(injection.kind).toBe("message");
    injected.push(injection.id);
    state.busy = true;
  } } satisfies Pick<ConversationAdapter, "inject">);

  const pi = {
    on: (event: string, handler: PiHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);

      return () => {};
    },
    emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) {
        handler({}, { isIdle: () => !state.busy });
      }
    },
  };

  deliverMessages(pi, receiver);
  pi.emit("session_start");

  const receive = (id: string, delivery: Message["delivery"] = "when_idle") =>
    receiver.receive({ type: "message", id, body: id, delivery });

  return { pi, state, receiver, receive, injected };
};

const tick = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test("working holds when_idle FIFO while after_turn overtakes FIFO; only idle settlement releases the batch once", () => {
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
  expect(injected).toEqual(["turn-1", "turn-2", "idle-1", "idle-2"]);
  expect(receiver.pending()).toEqual([]);
  receive("idle-3"); // The released batch has started work again.
  receive("idle-2");
  expect(receiver.pending()).toEqual(["idle-3"]);
  state.busy = false;
  pi.emit("agent_settled");
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
  expect(injected).toEqual(["held"]);
});
