/** The Worker Host control server: serves identity, launches, inventory and termination on the host socket. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { readBootId } from "./boot.js";
import {
  HOST_CONTROL_VERSION,
  hostSocketPath,
  readLines,
  type HostEvent,
  type HostIdentity,
  type HostResponse,
} from "./control.js";
import {
  LaunchRefused,
  TerminateRefused,
  createLaunchRegistry,
  type LaunchRegistry,
  type LaunchSpec,
  type TerminateOptions,
} from "./launches.js";

export interface RunningHost {
  readonly identity: HostIdentity;
  readonly socketPath: string;
  /**
   * Stops listening, drops control connections and removes the socket.
   * Launches are left running: stopping them is a separate, explicit decision.
   */
  close(): Promise<void>;
}

/** Serves the host control socket in `stateRoot` from the current process. */
export async function serveHost(stateRoot: string): Promise<RunningHost> {
  const socketPath = hostSocketPath(stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await clearStaleSocket(socketPath);

  const bootId = readBootId();
  const identity: HostIdentity = {
    hostId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    stateRoot,
    controlVersion: HOST_CONTROL_VERSION,
    bootId,
  };

  const clients = new Set<Socket>();
  const send = (socket: Socket, message: HostResponse | HostEvent): void => {
    if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
  };
  const registry = createLaunchRegistry({
    bootId,
    // An exit is reported to whoever is connected now; a client that was not
    // connected learns it from the inventory when it asks.
    onExit: (launch) => {
      for (const client of clients) send(client, { event: "launch-exited", launch });
    },
  });

  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    // A control client vanishing is ordinary; it must never take the host or a launch down.
    socket.on("error", () => {});
    readLines(socket, (line) => {
      // An unexpected failure answers this request; it must not take the host down.
      void answer(line, identity, registry)
        .catch((error: unknown): HostResponse => ({
          id: requestId(line),
          ok: false,
          error: `internal error: ${error instanceof Error ? error.message : String(error)}`,
        }))
        .then((response) => send(socket, response));
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

async function answer(line: string, identity: HostIdentity, registry: LaunchRegistry): Promise<HostResponse> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { id: null, ok: false, error: "malformed request: not JSON" };
  }
  if (typeof request !== "object" || request === null) {
    return { id: null, ok: false, error: "malformed request: not an object" };
  }
  const { id, op, spec } = request as { id?: unknown; op?: unknown; spec?: unknown };
  if (typeof id !== "number") {
    return { id: null, ok: false, error: "malformed request: missing numeric id" };
  }
  switch (op) {
    case "identify":
      return { id, ok: true, identity };
    case "inventory":
      return { id, ok: true, launches: registry.inventory() };
    case "launch": {
      const problem = checkLaunchSpec(spec);
      if (problem !== undefined) return { id, ok: false, error: `malformed launch spec: ${problem}` };
      try {
        return { id, ok: true, launch: await registry.launch(spec as LaunchSpec) };
      } catch (error) {
        if (error instanceof LaunchRefused) return { id, ok: false, error: error.message };
        throw error;
      }
    }
    case "terminate": {
      const { launchId, graceMs, killWaitMs } = request as Record<string, unknown>;
      if (typeof launchId !== "string" || launchId === "") {
        return { id, ok: false, error: "malformed terminate: launchId must be a non-empty string" };
      }
      for (const [name, value] of [["graceMs", graceMs], ["killWaitMs", killWaitMs]] as const) {
        if (value !== undefined && !(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
          return { id, ok: false, error: `malformed terminate: ${name} must be a non-negative number` };
        }
      }
      const options: { -readonly [K in keyof TerminateOptions]: TerminateOptions[K] } = {};
      if (graceMs !== undefined) options.graceMs = graceMs as number;
      if (killWaitMs !== undefined) options.killWaitMs = killWaitMs as number;
      try {
        return { id, ok: true, termination: await registry.terminate(launchId, options) };
      } catch (error) {
        if (error instanceof TerminateRefused) return { id, ok: false, error: error.message };
        throw error;
      }
    }
    default:
      return { id, ok: false, error: `unknown op: ${String(op)}` };
  }
}

function requestId(line: string): number | null {
  try {
    const { id } = JSON.parse(line) as { id?: unknown };
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** Names the first thing wrong with a launch spec, or returns undefined. */
function checkLaunchSpec(spec: unknown): string | undefined {
  if (typeof spec !== "object" || spec === null) return "not an object";
  const s = spec as Record<string, unknown>;
  for (const field of ["factoryId", "slotId", "command", "cwd"] as const) {
    if (typeof s[field] !== "string" || s[field] === "") return `${field} must be a non-empty string`;
  }
  if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === "string")) {
    return "args must be an array of strings";
  }
  if (s.env !== undefined) {
    if (typeof s.env !== "object" || s.env === null || Array.isArray(s.env)) return "env must be an object";
    if (!Object.values(s.env).every((v) => typeof v === "string")) return "env values must be strings";
  }
  return undefined;
}

/**
 * Refuses if a host already answers; removes a socket file nobody answers on.
 * Probe-then-unlink is racy between two concurrent starters, so callers must
 * hold the state-root instance lock while starting a host.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  const probe = await new Promise<"answered" | "stale" | Error>((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve("answered");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : error);
    });
  });
  if (probe === "answered") {
    throw new Error(`a Worker Host already answers on ${socketPath}`);
  }
  if (probe instanceof Error) {
    throw new Error(`cannot tell whether a Worker Host answers on ${socketPath}: ${probe.message}`);
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
