/** Own one launch's channel and retry policy, independent of Pi and the socket transport. */
import { RECONNECT_BACKOFF_CAP_MS } from "@foundry/protocol";
import type { Hello, HelloRejectReason } from "@foundry/protocol";
import { openChannel } from "./client.js";
import type { OpenChannel, OpenChannelOptions } from "./client.js";

export interface WorkerConnectionOptions {
  readonly socketPath: string;
  readonly onFrame: NonNullable<OpenChannelOptions["onFrame"]>;
  readonly attach: (channel: OpenChannel) => void;
  readonly refuse: (reason: HelloRejectReason) => void;
  readonly failed: (cause: unknown) => void;
  readonly dial?: typeof openChannel;
}

export class WorkerConnection {
  private generation = 0;
  private stopped = false;
  private terminal = false;
  private abort: AbortController | undefined;
  private channel: OpenChannel | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private backoff = 250;

  constructor(private readonly options: WorkerConnectionOptions) {}

  /** Re-announce session/reload observations, even on a live connection. Never reuse an old hello. */
  start(hello: () => Hello): Promise<void> {
    if (this.stopped || this.terminal) {return Promise.resolve();}

    this.invalidate();
    this.backoff = 250;

    return this.dial(this.generation, hello);
  }

  /** Shutdown is final for this extension instance; a reload creates a new instance. */
  stop(): void {
    this.stopped = true;
    this.invalidate();
  }

  private invalidate(): void {
    this.generation += 1;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.channel?.close();
    this.channel = undefined;
  }

  private current(generation: number): boolean {
    return generation === this.generation && !this.stopped && !this.terminal;
  }

  private schedule(generation: number, hello: () => Hello): void {
    if (!this.current(generation) || this.retry !== undefined) {return;}

    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.dial(generation, hello);
    }, this.backoff);
    this.retry.unref();
    this.backoff = Math.min(this.backoff * 2, RECONNECT_BACKOFF_CAP_MS);
  }

  private async dial(generation: number, hello: () => Hello): Promise<void> {
    if (!this.current(generation)) {return;}

    const abort = new AbortController();
    this.abort = abort;

    try {
      const result = await (this.options.dial ?? openChannel)({
        socketPath: this.options.socketPath, hello: hello(), signal: abort.signal,
        onFrame: (frame, channel) => {
          if (this.current(generation)) {this.options.onFrame(frame, channel);}
        },
      });

      if (!this.current(generation)) {
        if (result.accepted) {result.channel.close();}

        return;
      }

      if (!result.accepted) {
        if (result.reason.kind === "terminal") {
          this.terminal = true;
          this.invalidate();
        }

        this.options.refuse(result.reason);
        this.schedule(generation, hello);

        return;
      }

      const channel = result.channel;
      this.channel = channel;
      this.backoff = 250;
      this.options.attach(channel);
      void channel.closed.then(() => {
        if (!this.current(generation) || this.channel !== channel) {return;}

        this.channel = undefined;
        this.schedule(generation, hello);
      });
    } catch (cause) {
      if (!this.current(generation)) {return;}

      this.options.failed(cause);
      this.schedule(generation, hello);
    } finally {
      if (this.abort === abort) {this.abort = undefined;}
    }
  }
}
