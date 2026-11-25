/**
 * The worker end of the channel (PRD §3.2, §5.3). Plain TypeScript with
 * promises: dial the daemon's socket, send `hello` as the first frame, wait for
 * the reply, then heartbeat on a fixed interval while the channel is open.
 */
import { connect, type Socket } from "node:net";
import {
  decodeHelloReplyLine,
  encodeFrame,
  FrameLineSplitter,
  HEARTBEAT_INTERVAL_MS,
  type Hello,
  type HelloRejectReason,
} from "@foundry/protocol";

export interface OpenChannel {
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
    socket.on("data", (chunk: string) => {
      if (settled) return;
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch (error) {
        return fail(error as Error);
      }
      const first = lines[0];
      if (first === undefined) return;
      const reply = decodeHelloReplyLine(first);
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
      resolve({
        accepted: true,
        channel: {
          close: () => {
            stop();
            socket.end();
          },
          closed,
        },
      });
    });
  });
