/**
 * The worker end of the channel (PRD §3.2, §5.3). Plain TypeScript with
 * promises: dial the daemon's socket, send `hello` as the first frame, wait for
 * the reply, then heartbeat on a fixed interval while the channel is open.
 */
import { connect } from "node:net";
import type { Socket } from "node:net";
import { decodeDaemonFrameLine, decodeHelloReplyLine, encodeFrame, FrameLineSplitter, HEARTBEAT_INTERVAL_MS, CHANNEL_LOST_AFTER_MS } from "@foundry/protocol";
import type { DaemonFrame, Hello, HelloRejectReason, WorkerFrame } from "@foundry/protocol";

export interface OpenChannel {
  /** Write one frame. Resolves once written to the socket; rejects if the channel is closed. */
  send(frame: WorkerFrame): Promise<void>;
  /** Stop heartbeating and close the connection. */
  close(): void;
  /** Settles when the connection ends, for whatever reason. */
  readonly closed: Promise<void>;
}

export type ChannelOpenResult =
  | { readonly accepted: true; readonly channel: OpenChannel }
  | { readonly accepted: false; readonly reason: HelloRejectReason };

export interface OpenChannelOptions {
  readonly socketPath: string;
  readonly hello: Hello;
  /** Cancels a pending handshake or closes its accepted channel. */
  readonly signal?: AbortSignal;
  readonly heartbeatIntervalMs?: number;
  /**
   * A frame the daemon sent after accepting the hello, with the channel it
   * arrived on (so a reply can go out even before `openChannel` resolves).
   * A malformed daemon frame closes the channel.
   */
  readonly onFrame?: (frame: DaemonFrame, channel: OpenChannel) => void;
}

/**
 * Open the channel and complete the hello. Rejects only on transport failure
 * (no listener, connection dropped before a reply); a refusal from the daemon
 * resolves with its reason so the caller can tell terminal from retryable.
 */
export const openChannel = (options: OpenChannelOptions): Promise<ChannelOpenResult> =>
  new Promise((resolve, reject) => {
    const socket: Socket = connect(options.socketPath);
    socket.setEncoding("utf8");
    const splitter = new FrameLineSplitter();
    let settled = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const closed = new Promise<void>((done) => {
      socket.once("close", () => done());
    });

    const stop = (): void => {
      if (heartbeat) {clearInterval(heartbeat);}

      heartbeat = undefined;
    };

    void closed.then(stop);

    // Rejects with the value as thrown or emitted: socket errors and splitter overflows are Errors.
    const fail = (cause: unknown): void => {
      if (settled) {return;}

      settled = true;
      socket.destroy();
      reject(cause);
    };

    const abort = (): void => {
      if (!settled) {fail(new Error("channel dial cancelled"));} else {socket.destroy();}
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => options.signal?.removeEventListener("abort", abort));

    if (options.signal?.aborted) {
      abort();

      return;
    }

    // Bound unanswered hellos too: a listener may accept transport but never answer.
    socket.setTimeout(CHANNEL_LOST_AFTER_MS, () => fail(new Error("channel hello timed out")));
    socket.once("connect", () => socket.write(encodeFrame(options.hello)));
    socket.on("error", fail);
    socket.once("close", () => fail(new Error("channel closed before the hello was answered")));
    let channel: OpenChannel | undefined;
    socket.on("data", (chunk: string) => {
      let lines: Array<string>;

      try {
        lines = splitter.push(chunk);
      } catch (error) {
        if (!settled) {return fail(error);}

        socket.destroy();

        return;
      }

      for (const line of lines) {
        if (!settled) {
          const reply = decodeHelloReplyLine(line);

          if (!reply.ok) {return fail(new Error(`malformed hello reply: ${reply.detail}`));}

          settled = true;
          socket.setTimeout(0);

          if (reply.value.type === "hello_rejected") {
            socket.destroy();

            return resolve({ accepted: false, reason: reply.value.reason });
          }

          heartbeat = setInterval(
            () => socket.write(encodeFrame({ type: "heartbeat" })),
            options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
          );
          channel = {
            send: (frame) =>
              new Promise<void>((done, failed) => {
                if (socket.destroyed || !socket.writable) {
                  failed(new Error("channel is closed"));

                  return;
                }

                socket.write(encodeFrame(frame), (error) => (error ? failed(error) : done()));
              }),
            close: () => {
              stop();
              socket.destroy();
            },
            closed,
          };
          resolve({ accepted: true, channel });
          continue;
        }

        if (!channel) {return;} // refused: nothing after the refusal is read

        const frame = decodeDaemonFrameLine(line);

        if (!frame.ok) {
          socket.destroy();

          return;
        }

        try {
          options.onFrame?.(frame.value, channel);
        } catch {
          // A throwing handler must not crash the Pi process; drop the channel instead.
          socket.destroy();

          return;
        }
      }
    });
  });
