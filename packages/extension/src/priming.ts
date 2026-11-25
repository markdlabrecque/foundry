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
import type { RunInterrupter } from "./interrupt.js";
import type { ToolCallClient } from "./tool-calls.js";
import { MessageReceiver } from "./messages.js";

/**
 * Sends receipts over the attached channel, holding them while there is none.
 * Held receipts live in memory only and are lost if the worker restarts; the
 * daemon reconciles unacknowledged IDs on reconnect (17a).
 */
export class ReceiptReporter {
  private readonly held: Array<string> = [];
  private sending = false;
  private channel: OpenChannel | undefined;

  constructor(private readonly frameType: "receipt" | "message_injected" = "receipt") {}

  /** Pass as the adapter's `onReceipt`, or the message receiver's injection callback. */
  readonly record = (id: string): void => {
    this.held.push(id);
    this.flush();
  };

  /** Use `channel` for receipts until it closes, sending any held meanwhile. */
  attach(channel: OpenChannel): void {
    this.channel = channel;
    void channel.closed.then(() => {
      if (this.channel === channel) {this.channel = undefined;}
    });
    this.flush();
  }

  /** Receipts issued but not yet written to a channel. */
  pending(): ReadonlyArray<string> {
    return [...this.held];
  }

  private flush(): void {
    const channel = this.channel;
    const id = this.held[0];

    if (id === undefined || this.sending || !channel) {return;}

    this.sending = true;
    channel.send({ type: this.frameType, id }).then(
      () => {
        if (this.held[0] === id) {this.held.shift();}

        this.sending = false;
        this.flush();
      },
      () => {
        // Keep the receipt for the next attach(); see CompactionReporter for why no retry here.
        if (this.channel === channel) {this.channel = undefined;}

        this.sending = false;
      },
    );
  }
}

export interface DaemonFrameHandlers {
  readonly adapter: Pick<ConversationAdapter, "inject" | "pending" | "classify">;
  readonly messages?: Pick<MessageReceiver, "receive" | "drain" | "pending"> & Partial<Pick<MessageReceiver, "lifecycle">>;
  readonly interrupter: Pick<RunInterrupter, "handle" | "handleDrain">;
  /** Receives tool results. Without one, a result is dropped: no call can be waiting on it. */
  readonly toolCalls?: Pick<ToolCallClient, "receive">;
}

/**
 * The one dispatcher for daemon frames. Pass as `openChannel`'s `onFrame`:
 * a prime goes into the conversation (never starting a turn), an interrupt to
 * the run interrupter, which answers on the channel the frame arrived on, and
 * a drain to the same interrupter, which answers once Pi settles.
 */
export const receiveDaemonFrames = (handlers: DaemonFrameHandlers) => {
  const messages = handlers.messages ?? new MessageReceiver(handlers.adapter);

  return (frame: DaemonFrame, channel: OpenChannel): void => {
    switch (frame.type) {
      case "reconcile": {
        let ended = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        void channel.closed.then(() => { ended = true; clearTimeout(timer); });

        const compare = () => {
          if (ended) {return;}

          const lifecycle = messages.lifecycle?.() ?? "unknown";

          if (frame.whenIdle && lifecycle === "working") {
            // Standalone compaction has no settled event after its busy flag clears.
            // Observe only while a requested idle comparison is outstanding.
            timer = setTimeout(compare, 25);
            timer.unref();

            return;
          }

          const held = new Set(messages.pending());

          const answers = handlers.adapter.classify(frame.ids).map((answer) =>
            answer.status === "absent" && held.has(answer.id) ? { id: answer.id, status: "pending" as const } : answer);

          void channel.send({ type: "reconciliation_answer", requestId: frame.requestId, lifecycle, answers }).catch(() => {});
        };

        compare();

        return;
      }

      case "prime":
        handlers.adapter.inject({ id: frame.id, kind: "prime", content: frame.text });

        return;
      case "message":
        messages.receive(frame);

        return;
      case "interrupt":
        handlers.interrupter.handle(frame, channel);

        return;
      case "drain":
        messages.drain();
        handlers.interrupter.handleDrain(frame, channel);

        return;
      case "tool_result":
        handlers.toolCalls?.receive(frame);

        return;
      default: {
        const unhandled: never = frame;
        throw new Error(`unhandled daemon frame ${JSON.stringify(unhandled)}`);
      }
    }
  };
};
