/**
 * Compaction reporting (PRD §5.5). The extension tells the daemon that Pi
 * compacted the conversation; the daemon decides what to do about it.
 *
 * Only Pi's `session_compact` event counts as a compaction: crossing the
 * threshold, `session_before_compact` and `session_compact_failed` do not
 * (docs/evidence/compaction-event.md). If the channel is down when Pi
 * compacts, the report is kept and sent once on the next attached channel.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenChannel } from "./channel/client.js";

export class CompactionReporter {
  private pending = false;
  private sending = false;
  private channel: OpenChannel | undefined;

  /** Note a completed compaction and report it now if a channel is attached. */
  record(): void {
    this.pending = true;
    this.flush();
  }

  /** Use `channel` for reports until it closes, sending any report held meanwhile. */
  attach(channel: OpenChannel): void {
    this.channel = channel;
    void channel.closed.then(() => {
      if (this.channel === channel) this.channel = undefined;
    });
    this.flush();
  }

  private flush(): void {
    const channel = this.channel;
    if (!this.pending || this.sending || !channel) return;
    this.pending = false;
    this.sending = true;
    channel.send({ type: "compacted" }).then(
      () => {
        this.sending = false;
        this.flush(); // a compaction recorded while this report was in flight
      },
      () => {
        // The channel died under the write: drop it and keep the report for the
        // next attach(). Retrying here would spin on a channel whose `closed`
        // has not settled yet, starving the event loop.
        if (this.channel === channel) this.channel = undefined;
        this.pending = true;
        this.sending = false;
      },
    );
  }
}

/** Feed Pi's completed-compaction event, and nothing else, into `reporter`. */
export const reportCompactions = (pi: Pick<ExtensionAPI, "on">, reporter: CompactionReporter): void => {
  pi.on("session_compact", () => reporter.record());
};
