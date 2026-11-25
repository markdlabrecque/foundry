/** The Worker Host control server: serves identity on the host socket. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import {
  HOST_CONTROL_VERSION,
  hostSocketPath,
  readLines,
  type HostIdentity,
  type HostResponse,
} from "./control.js";

export interface RunningHost {
  readonly identity: HostIdentity;
  readonly socketPath: string;
  /** Stops listening, drops control connections and removes the socket. */
  close(): Promise<void>;
}

/** Serves the host control socket in `stateRoot` from the current process. */
export async function serveHost(stateRoot: string): Promise<RunningHost> {
  const socketPath = hostSocketPath(stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await clearStaleSocket(socketPath);

  const identity: HostIdentity = {
    hostId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    stateRoot,
    controlVersion: HOST_CONTROL_VERSION,
  };

  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    // A control client vanishing is ordinary; it must never take the host down.
    socket.on("error", () => {});
    readLines(socket, (line) => {
      if (!socket.writable) return;
      socket.write(`${JSON.stringify(answer(line, identity))}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Filesystem permissions are the only access control in P0.
  await chmod(socketPath, 0o600);

  let closing: Promise<void> | undefined;
  return {
    identity,
    socketPath,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        for (const client of clients) client.destroy();
        server.close(() => resolve());
      })),
  };
}

function answer(line: string, identity: HostIdentity): HostResponse {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { id: null, ok: false, error: "malformed request: not JSON" };
  }
  if (typeof request !== "object" || request === null) {
    return { id: null, ok: false, error: "malformed request: not an object" };
  }
  const { id, op } = request as { id?: unknown; op?: unknown };
  if (typeof id !== "number") {
    return { id: null, ok: false, error: "malformed request: missing numeric id" };
  }
  if (op === "identify") return { id, ok: true, identity };
  return { id, ok: false, error: `unknown op: ${String(op)}` };
}

/** Refuses if a host already answers; removes a socket file nobody answers on. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  const answered = await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (answered) {
    throw new Error(`a Worker Host already answers on ${socketPath}`);
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
