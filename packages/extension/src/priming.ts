/**
 * The extension's half of priming (PRD §5.5): a `prime` frame from the daemon
 * is injected through the conversation adapter, which never lets a prime start
 * a turn, and every receipt the adapter issues travels back as a `receipt`
 * frame. Receipts issued while the channel is down are kept and sent, in
 * order, on the next attached channel.
 */
import type { DaemonFrame } from "@foundry/protocol";
import type { OpenChannel } from "./channel/client.js";
import type { ConversationAdapter } from "./conversation/adapter.js";

/**
 * Sends receipts over the attached channel, holding them while there is none.
 * Held receipts live in memory only and are lost if the worker restarts; the
 * daemon reconciles unacknowledged IDs on reconnect (17a).
 */
export class ReceiptReporter {
  private readonly held: string[] = [];
  private sending = false;
  private channel: OpenChannel | undefined;

  /** Pass as the adapter's `onReceipt`. */
  readonly record = (id: string): void => {
    this.held.push(id);
    this.flush();
  };

  /** Use `channel` for receipts until it closes, sending any held meanwhile. */
  attach(channel: OpenChannel): void {
    this.channel = channel;
    void channel.closed.then(() => {
      if (this.channel === channel) this.channel = undefined;
    });
    this.flush();
  }

  /** Receipts issued but not yet written to a channel. */
  pending(): readonly string[] {
    return [...this.held];
  }

  private flush(): void {
    const channel = this.channel;
    const id = this.held[0];
    if (id === undefined || this.sending || !channel) return;
    this.sending = true;
    channel.send({ type: "receipt", id }).then(
      () => {
        if (this.held[0] === id) this.held.shift();
        this.sending = false;
        this.flush();
      },
      () => {
        // Keep the receipt for the next attach(); see CompactionReporter for why no retry here.
        if (this.channel === channel) this.channel = undefined;
        this.sending = false;
      },
    );
  }
}

/** Route daemon frames into the conversation. Pass as `openChannel`'s `onFrame`. */
export const receiveDaemonFrames =
  (adapter: Pick<ConversationAdapter, "inject">) =>
  (frame: DaemonFrame): void => {
    if (frame.type === "prime") adapter.inject({ id: frame.id, kind: "prime", content: frame.text });
  };
