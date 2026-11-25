/** Delivery policy belongs here, not in the daemon's socket/liveness state. */
import type { Message } from "@foundry/protocol";
import type { ConversationAdapter } from "./conversation/adapter.js";

export class MessageReceiver {
  private readonly seen = new Set<string>();
  // when_idle settlement is a separate delivery-policy ticket. Retain, never inject early.
  private readonly held = new Map<string, Message>();

  constructor(private readonly adapter: Pick<ConversationAdapter, "inject">) {}

  receive(message: Message): void {
    if (this.seen.has(message.id)) {return;}

    this.seen.add(message.id);

    if (message.delivery === "when_idle") {
      this.held.set(message.id, message);

      return;
    }

    this.adapter.inject({ id: message.id, kind: "message", content: message.body }, { triggerTurn: true });
  }

  pending(): ReadonlyArray<string> { return [...this.held.keys()]; }
}
