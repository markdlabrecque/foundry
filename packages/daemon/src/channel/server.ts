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
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { CHANNEL_LOST_AFTER_MS, decodeHelloLine, decodeWorkerFrameLine, encodeFrame, FrameLineSplitter, PROTOCOL_VERSION } from "@foundry/protocol";
import type { DaemonFrame, Hello, HelloRejectReason, InterruptOutcome, WorkerFrame } from "@foundry/protocol";

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

/** Writes daemon frames to one accepted connection, in call order. */
export interface AcceptedConnection {
  /** Resolves once written to the socket; rejects if the connection has ended. */
  send(frame: DaemonFrame): Promise<void>;
}

export interface ChannelEvents {
  /**
   * An authenticated frame from an accepted connection, attributed to its claimed
   * slot. Includes `interrupt_ack`, after it has settled the matching `interrupt()` call.
   */
  onFrame?(slot: ClaimedSlot, frame: WorkerFrame): void;
  onAccepted?(slot: ClaimedSlot, hello: Hello, connection: AcceptedConnection): void;
  onRejected?(reason: HelloRejectReason): void;
  onChannelLost?(slot: ClaimedSlot, cause: ChannelLostCause): void;
}

/** How long a refused peer gets to read its `hello_rejected` before the socket is destroyed. */
export const REJECTED_SOCKET_GRACE_MS = 1000;

export interface ChannelServerOptions extends ChannelEvents {
  readonly socketPath: string;
  readonly slotClaim: SlotClaim;
  readonly channelLostAfterMs?: number;
  readonly lapseTimer?: LapseTimer;
}

/** No accepted channel speaks for the launch, or it was lost before the worker acknowledged. */
export class ChannelUnavailableError extends Error {
  constructor(readonly launchId: string, detail: string) {
    super(`channel for launch ${launchId} ${detail}`);
    this.name = "ChannelUnavailableError";
  }
}

export interface ChannelServer {
  readonly socketPath: string;
  /**
   * Ask the worker on `launchId`'s accepted channel to abort its current Pi run
   * (PRD §3.2). Resolves with the worker's acknowledgement, once Pi is idle;
   * the launch and conversation are kept. Rejects with
   * `ChannelUnavailableError` if no channel is accepted for the launch or it is
   * lost before the ack. Callers bound the wait themselves.
   */
  interrupt(launchId: string): Promise<InterruptOutcome>;
  close(): Promise<void>;
}

/** Start listening on `socketPath`. Socket permissions (0600) are P0's only access control. */
export const startChannelServer = async (options: ChannelServerOptions): Promise<ChannelServer> => {
  const lostAfter = options.channelLostAfterMs ?? CHANNEL_LOST_AFTER_MS;
  const timer = options.lapseTimer ?? realTimer;
  const connections = new Set<Socket>();
  let closing = false;

  /** Accepted channels by launch, with interrupts awaiting their ack. */
  interface Accepted {
    /** The one writer for this connection; `interrupt()` and the primer both write through it. */
    readonly connection: AcceptedConnection;
    readonly pending: Map<string, { resolve: (o: InterruptOutcome) => void; reject: (e: Error) => void }>;
  }

  const byLaunch = new Map<string, Accepted>();

  const handle = (socket: Socket): void => {
    connections.add(socket);
    socket.setEncoding("utf8");
    const splitter = new FrameLineSplitter();
    let state: "awaiting_hello" | "claiming" | "accepted" | "ended" = "awaiting_hello";
    let slot: ClaimedSlot | undefined;
    let cancelLapse: (() => void) | undefined;
    let accepted: Accepted | undefined;

    const end = (cause: ChannelLostCause): void => {
      if (state === "ended") {return;}

      const wasAccepted = state === "accepted";
      state = "ended";
      cancelLapse?.();
      socket.destroy();

      if (accepted && slot) {
        if (byLaunch.get(slot.launchId) === accepted) {byLaunch.delete(slot.launchId);}

        for (const { reject } of accepted.pending.values()) {
          reject(new ChannelUnavailableError(slot.launchId, `was lost before the interrupt was acknowledged (${cause})`));
        }

        accepted.pending.clear();
      }

      if (wasAccepted && slot) {options.onChannelLost?.(slot, cause);}
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

      if (!decoded.ok) {return reject(decoded.reason);}

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

      if (state !== "claiming") {return;} // peer went away while the claim ran

      if (!result.accepted) {return reject(result.reason);}

      slot = result.slot;
      state = "accepted";

      const connection: AcceptedConnection = {
        send: (frame) =>
          new Promise<void>((done, failed) => {
            if (state !== "accepted" || socket.destroyed || !socket.writable) {
              return failed(new Error("channel connection has ended"));
            }

            socket.write(encodeFrame(frame), (error) => (error ? failed(error) : done()));
          }),
      };

      accepted = { connection, pending: new Map() };
      byLaunch.set(slot.launchId, accepted);
      socket.write(encodeFrame({ type: "hello_accepted", protocolVersion: PROTOCOL_VERSION }));
      armLapse();
      options.onAccepted?.(slot, decoded.value, connection);
    };

    // Lines are handled strictly in order; nothing after the hello is read until the claim settles.
    let queue = Promise.resolve();

    const onLine = (line: string): Promise<void> => {
      if (state === "awaiting_hello") {return onHello(line);}

      if (state !== "accepted" || !slot) {return Promise.resolve();}

      const decoded = decodeWorkerFrameLine(line);

      if (!decoded.ok) {
        end("protocol_error");

        return Promise.resolve();
      }

      if (decoded.value.type === "heartbeat") {armLapse();}

      if (decoded.value.type === "interrupt_ack") {
        const waiter = accepted?.pending.get(decoded.value.requestId);
        accepted?.pending.delete(decoded.value.requestId);
        waiter?.resolve(decoded.value.outcome);
      }

      options.onFrame?.(slot, decoded.value);

      return Promise.resolve();
    };

    // A peer that never completes its hello is dropped on the same deadline; no slot is reported lost.
    armLapse();

    socket.on("data", (chunk: string) => {
      let lines: Array<string>;

      try {
        lines = splitter.push(chunk);
      } catch {
        end("protocol_error");

        return;
      }

      for (const line of lines) {queue = queue.then(() => onLine(line));}
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
    interrupt: (launchId) =>
      new Promise<InterruptOutcome>((resolve, reject) => {
        const channel = byLaunch.get(launchId);

        if (!channel) {return reject(new ChannelUnavailableError(launchId, "is not connected"));}

        const requestId = randomUUID();
        channel.pending.set(requestId, { resolve, reject });
        // Written straight to the connection, not through the primer's queue: an
        // interrupt is a control frame, outside §5.5's prime-before-messages ordering.
        channel.connection.send({ type: "interrupt", requestId }).catch((error: unknown) => {
          channel.pending.delete(requestId);
          reject(new ChannelUnavailableError(launchId, `could not be written to (${String(error)})`));
        });
      }),
    close: async () => {
      closing = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));

      for (const socket of connections) {socket.destroy();}

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return;}

    throw error;
  }

  if (!stats.isSocket()) {throw new Error(`refusing to replace non-socket file at ${path}`);}

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
