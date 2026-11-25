/** Delivery policy belongs here, not in the daemon's socket/liveness state. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@foundry/protocol";
import type { ConversationAdapter } from "./conversation/adapter.js";

export class MessageReceiver {
  private readonly seen = new Set<string>();
  private readonly held = new Map<string, Message>();
  private control: Pick<ExtensionContext, "isIdle"> | undefined;
  private draining = false;
  private batchTail: string | undefined;

  constructor(private readonly adapter: Pick<ConversationAdapter, "inject" | "pending">) {}

  bind(control: Pick<ExtensionContext, "isIdle">): void {
    this.control = control;
    this.settled();
  }

  receive(message: Message): void {
    if (this.seen.has(message.id)) {return;}

    this.seen.add(message.id);

    if (message.delivery === "when_idle") {
      this.held.set(message.id, message);
      this.settled();

      return;
    }

    this.inject(message);
  }

  /** A drained launch must not start more work from its held queue. */
  drain(): void { this.draining = true; }

  /** Check held delivery. False means Pi is still busy and needs a later check. */
  settled(): boolean {
    if (this.draining || this.held.size === 0 || !this.control) {return true;}

    // Pi invalidates captured contexts on dispose/reload, even when a scheduled
    // settlement callback is still queued. Never inject into a replaced runtime.
    try {
      if (!this.control.isIdle()) {return false;}
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("This extension ctx is stale")) {throw error;}

      this.control = undefined;

      return true;
    }

    // Pi can defer triggerTurn while emitting settlement, awaiting its entire run
    // before the next deferred injection. Append the prefix without starting work,
    // and let only the tail trigger a turn. Do not release another batch until that
    // tail is recoverable, even if async settle handlers leave Pi apparently idle.
    if (this.batchTail !== undefined && this.adapter.pending().includes(this.batchTail)) {return true;}

    const batch = [...this.held.values()];
    const tail = batch.at(-1);

    if (tail === undefined) {return true;}

    this.batchTail = tail.id;
    this.held.clear();

    for (const message of batch) {this.inject(message, message === tail);}

    return true;
  }

  pending(): ReadonlyArray<string> { return [...this.held.keys()]; }

  private inject(message: Message, triggerTurn = true): void {
    this.adapter.inject({ id: message.id, kind: "message", content: message.body }, { triggerTurn });
  }
}

/** Feed Pi's actual settled state into the policy receiver, including standalone compaction. */
export const deliverMessages = (pi: Pick<ExtensionAPI, "on">, receiver: MessageReceiver): void => {
  let compactionRetry: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", (_event, ctx) => receiver.bind(ctx));

  pi.on("session_shutdown", () => {
    receiver.drain();
    clearTimeout(compactionRetry);
    compactionRetry = undefined;
  });
  // Yield to Pi's lifecycle bookkeeping. Async handlers can keep settlement open
  // past this callback, so batch-tail gating above (not timing) guarantees FIFO.
  const settled = () => { setImmediate(() => receiver.settled()); };

  pi.on("agent_settled", settled);

  // Pi clears standalone compaction only after every async session_compact
  // handler returns, with no subsequent extension settled event. Keep observing
  // busy state at a bounded rate rather than assuming one event-loop tick suffices.
  const compacted = () => {
    clearTimeout(compactionRetry);
    compactionRetry = undefined;

    if (!receiver.settled()) {
      compactionRetry = setTimeout(compacted, 25);
      compactionRetry.unref();
    }
  };

  pi.on("session_compact", () => { setImmediate(compacted); });
  pi.on("session_compact_failed", settled);
};
