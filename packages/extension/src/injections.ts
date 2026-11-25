/** Injection reports are not receipts. Retain the original wall time until Pi confirms
 * recoverable history, and replay on every channel attach: a successful socket write
 * alone does not prove the daemon committed it before a crash. */
import type { OpenChannel } from "./channel/client.js";

export class InjectionReporter {
  private readonly outstanding = new Map<string, number>();
  private channel: OpenChannel | undefined;

  readonly record = (id: string): void => {
    if (this.outstanding.has(id)) {return;}

    const injectedAt = Date.now();
    this.outstanding.set(id, injectedAt);
    this.send(id, injectedAt);
  };

  /** Once recoverable, receipt replay or reconciliation will acknowledge it instead. */
  forget(id: string): void { this.outstanding.delete(id); }

  attach(channel: OpenChannel): void {
    this.channel = channel;
    void channel.closed.then(() => {
      if (this.channel === channel) {this.channel = undefined;}
    });

    for (const [id, injectedAt] of this.outstanding) {this.send(id, injectedAt);}
  }

  private send(id: string, injectedAt: number): void {
    const channel = this.channel;

    if (channel === undefined) {return;}

    void channel.send({ type: "message_injected", id, injectedAt }).catch(() => {
      if (this.channel === channel) {this.channel = undefined;}
    });
  }
}
