/**
 * The worker end of the channel (PRD §3.2, §5.3). Plain TypeScript with
 * promises: dial the daemon's socket, send `hello` as the first frame, wait for
 * the reply, then heartbeat on a fixed interval while the channel is open.
 */
import { connect, type Socket } from "node:net";
import {
  decodeDaemonFrameLine,
  decodeHelloReplyLine,
  type DaemonFrame,
  encodeFrame,
  FrameLineSplitter,
  HEARTBEAT_INTERVAL_MS,
  type Hello,
  type HelloRejectReason,
  type WorkerFrame,
} from "@foundry/protocol";

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
    const closed = new Promise<void>((done) => socket.once("close", () => done()));

    const stop = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };
    closed.then(stop);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => socket.write(encodeFrame(options.hello)));
    socket.on("error", fail);
    socket.once("close", () => fail(new Error("channel closed before the hello was answered")));
    let channel: OpenChannel | undefined;
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch (error) {
        if (!settled) return fail(error as Error);
        socket.destroy();
        return;
      }
      for (const line of lines) {
        if (!settled) {
          const reply = decodeHelloReplyLine(line);
          if (!reply.ok) return fail(new Error(`malformed hello reply: ${reply.detail}`));
          settled = true;
          if (reply.value.type === "hello_rejected") {
            socket.end();
            return resolve({ accepted: false, reason: reply.value.reason });
          }
          heartbeat = setInterval(
            () => socket.write(encodeFrame({ type: "heartbeat" })),
            options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
          );
          channel = {
            send: (frame) =>
              new Promise<void>((done, failed) => {
                if (socket.destroyed || !socket.writable) return failed(new Error("channel is closed"));
                socket.write(encodeFrame(frame), (error) => (error ? failed(error) : done()));
              }),
            close: () => {
              stop();
              socket.end();
            },
            closed,
          };
          resolve({ accepted: true, channel });
          continue;
        }
        if (!channel) return; // refused: nothing after the refusal is read
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
