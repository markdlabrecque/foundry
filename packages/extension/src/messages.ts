/** Delivery policy belongs here, not in the daemon's socket/liveness state. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@foundry/protocol";
import type { ConversationAdapter } from "./conversation/adapter.js";

export class MessageReceiver {
  private readonly seen = new Set<string>();
  private readonly held = new Map<string, Message>();
  private control: Pick<ExtensionContext, "isIdle"> | undefined;

  constructor(private readonly adapter: Pick<ConversationAdapter, "inject">) {}

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

  /** Only Pi's idle state permits a held batch, never a tool-round or run-end event. */
  settled(): void {
    if (!this.control?.isIdle()) {return;}

    // Take the entire FIFO batch before injection starts a new turn. Later arrivals wait
    // for that turn to settle, rather than overtaking any member of this batch.
    const batch = [...this.held.values()];
    this.held.clear();

    for (const message of batch) {this.inject(message);}
  }

  pending(): ReadonlyArray<string> { return [...this.held.keys()]; }

  private inject(message: Message): void {
    this.adapter.inject({ id: message.id, kind: "message", content: message.body }, { triggerTurn: true });
  }
}

/** Feed Pi's actual settled state into the policy receiver, including standalone compaction. */
export const deliverMessages = (pi: Pick<ExtensionAPI, "on">, receiver: MessageReceiver): void => {
  pi.on("session_start", (_event, ctx) => receiver.bind(ctx));
  pi.on("agent_settled", () => receiver.settled());
  // Successful compaction is emitted before Pi clears its busy flag.
  pi.on("session_compact", () => void setImmediate(() => receiver.settled()));
  pi.on("session_compact_failed", () => receiver.settled());
};
