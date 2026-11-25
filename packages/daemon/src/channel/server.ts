/**
 * The daemon end of the channel (PRD §3.2, §5.3): one Unix-domain socket per
 * instance, one long-lived stream per worker, newline-delimited JSON frames.
 *
 * The first frame must be a valid `hello`. Nothing a connection sends reaches
 * slot work until the injected `SlotClaim` accepts that hello; the claim, not
 * later frame contents, decides which slot the connection speaks for.
 *
 * A heartbeat lapse means only that the channel is lost. Whether the worker is
 * alive is the Worker Host's call, so this module never reports process death.
 */
import { chmod, lstat, mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  CHANNEL_LOST_AFTER_MS,
  decodeHelloLine,
  decodeWorkerFrameLine,
  encodeFrame,
  FrameLineSplitter,
  PROTOCOL_VERSION,
  type Hello,
  type HelloRejectReason,
  type WorkerFrame,
} from "@foundry/protocol";

/** The slot a connection was authorized for, as decided by the slot claim. */
export interface ClaimedSlot {
  readonly factoryId: string;
  readonly slotId: string;
  readonly launchId: string;
}

export type SlotClaimResult =
  | { readonly accepted: true; readonly slot: ClaimedSlot }
  | { readonly accepted: false; readonly reason: HelloRejectReason };

/**
 * Seam for authorizing a hello against host-confirmed launch identity (09b).
 * It sees only well-formed hellos of the current protocol version.
 */
export interface SlotClaim {
  claim(hello: Hello): Promise<SlotClaimResult>;
}

/** Schedules the channel-lost deadline; injectable so tests need no wall-clock waits. */
export type LapseTimer = (ms: number, onLapse: () => void) => () => void;

const realTimer: LapseTimer = (ms, onLapse) => {
  const handle = setTimeout(onLapse, ms);
  return () => clearTimeout(handle);
};

/** Why an accepted channel ended. Neither cause says anything about the worker process. */
export type ChannelLostCause = "heartbeat_lapse" | "peer_closed" | "protocol_error" | "server_closed";

export interface ChannelEvents {
  /** An authenticated frame from an accepted connection, attributed to its claimed slot. */
  onFrame?(slot: ClaimedSlot, frame: WorkerFrame): void;
  onAccepted?(slot: ClaimedSlot, hello: Hello): void;
  onRejected?(reason: HelloRejectReason): void;
  onChannelLost?(slot: ClaimedSlot, cause: ChannelLostCause): void;
}

/** How long a refused peer gets to read its `hello_rejected` before the socket is destroyed. */
export const REJECTED_SOCKET_GRACE_MS = 1_000;

export interface ChannelServerOptions extends ChannelEvents {
  readonly socketPath: string;
  readonly slotClaim: SlotClaim;
  readonly channelLostAfterMs?: number;
  readonly lapseTimer?: LapseTimer;
}

export interface ChannelServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Start listening on `socketPath`. Socket permissions (0600) are P0's only access control. */
export const startChannelServer = async (options: ChannelServerOptions): Promise<ChannelServer> => {
  const lostAfter = options.channelLostAfterMs ?? CHANNEL_LOST_AFTER_MS;
  const timer = options.lapseTimer ?? realTimer;
  const connections = new Set<Socket>();
  let closing = false;

  const handle = (socket: Socket): void => {
    connections.add(socket);
    socket.setEncoding("utf8");
    const splitter = new FrameLineSplitter();
    let state: "awaiting_hello" | "claiming" | "accepted" | "ended" = "awaiting_hello";
    let slot: ClaimedSlot | undefined;
    let cancelLapse: (() => void) | undefined;

    const end = (cause: ChannelLostCause): void => {
      if (state === "ended") return;
      const wasAccepted = state === "accepted";
      state = "ended";
      cancelLapse?.();
      socket.destroy();
      if (wasAccepted && slot) options.onChannelLost?.(slot, cause);
    };

    const armLapse = (): void => {
      cancelLapse?.();
      cancelLapse = timer(lostAfter, () => end("heartbeat_lapse"));
    };

    const reject = (reason: HelloRejectReason): void => {
      state = "ended";
      cancelLapse?.();
      options.onRejected?.(reason);
      socket.end(encodeFrame({ type: "hello_rejected", reason }));
      // A peer that never reads the refusal cannot hold the socket open.
      const grace = setTimeout(() => socket.destroy(), REJECTED_SOCKET_GRACE_MS);
      grace.unref();
      socket.once("close", () => clearTimeout(grace));
    };

    const onHello = async (line: string): Promise<void> => {
      const decoded = decodeHelloLine(line);
      if (!decoded.ok) return reject(decoded.reason);
      state = "claiming";
      let result: SlotClaimResult;
      try {
        result = await options.slotClaim.claim(decoded.value);
      } catch (error) {
        result = {
          accepted: false,
          reason: { kind: "retryable", code: "slot_claim_failed", detail: String(error) },
        };
      }
      if (state !== "claiming") return; // peer went away while the claim ran
      if (!result.accepted) return reject(result.reason);
      slot = result.slot;
      state = "accepted";
      socket.write(encodeFrame({ type: "hello_accepted", protocolVersion: PROTOCOL_VERSION }));
      armLapse();
      options.onAccepted?.(slot, decoded.value);
    };

    // Lines are handled strictly in order; nothing after the hello is read until the claim settles.
    let queue = Promise.resolve();
    const onLine = (line: string): Promise<void> => {
      if (state === "awaiting_hello") return onHello(line);
      if (state !== "accepted" || !slot) return Promise.resolve();
      const decoded = decodeWorkerFrameLine(line);
      if (!decoded.ok) {
        end("protocol_error");
        return Promise.resolve();
      }
      if (decoded.value.type === "heartbeat") armLapse();
      options.onFrame?.(slot, decoded.value);
      return Promise.resolve();
    };

    // A peer that never completes its hello is dropped on the same deadline; no slot is reported lost.
    armLapse();

    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        end("protocol_error");
        return;
      }
      for (const line of lines) queue = queue.then(() => onLine(line));
    });
    socket.on("close", () => {
      connections.delete(socket);
      end(closing ? "server_closed" : "peer_closed");
    });
    socket.on("error", () => end("peer_closed"));
  };

  await removeStaleSocket(options.socketPath);
  const server: Server = createServer(handle);
  await listenPrivately(server, options.socketPath);
  return {
    socketPath: options.socketPath,
    close: async () => {
      closing = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await closed;
      await removeStaleSocket(options.socketPath);
    },
  };
};

/**
 * Remove a leftover socket file at `path`, refusing to touch anything that is
 * not a socket. Callers must hold the state-root lock (05a), so a socket found
 * here belongs to no live daemon.
 */
const removeStaleSocket = async (path: string): Promise<void> => {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stats.isSocket()) throw new Error(`refusing to replace non-socket file at ${path}`);
  await unlink(path);
};

/**
 * Bind inside a fresh 0700 directory, set the socket to 0600, then rename it
 * into place, so no peer can connect while the socket still has default
 * permissions.
 */
const listenPrivately = async (server: Server, socketPath: string): Promise<void> => {
  const privateDir = await mkdtemp(join(dirname(socketPath), `.${basename(socketPath)}-`));
  const bindPath = join(privateDir, "s");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(bindPath, 0o600);
    await rename(bindPath, socketPath);
  } catch (error) {
    server.close();
    throw error;
  } finally {
    await unlink(bindPath).catch(() => {});
    await rmdir(privateDir);
  }
};
