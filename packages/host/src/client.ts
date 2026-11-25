/** Control-side seam: start a detached Worker Host and reach it over its socket. */
import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_CONTROL_VERSION,
  hostSocketPath,
  readLines,
  type HostEvent,
  type HostIdentity,
  type HostRequest,
  type HostResponse,
} from "./control.js";
import type { LaunchRecord, LaunchSpec } from "./launches.js";

/** Path, relative to the state root, of the file that receives the host's stderr (PRD §15.2). */
export const HOST_LOG_NAME = join("logs", "host.log");

export function hostLogPath(stateRoot: string): string {
  return join(stateRoot, HOST_LOG_NAME);
}

export interface StartHostOptions {
  /** How long to wait for the host's ready line. Default 10 s. */
  readonly readyTimeoutMs?: number;
}

/**
 * Starts a Worker Host detached from the caller, in its own process group,
 * and resolves once it serves its socket. The host keeps running after the
 * caller exits. Fails if a host already answers on the state root.
 */
export async function startHost(
  stateRoot: string,
  options: StartHostOptions = {},
): Promise<HostIdentity> {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "logs"), { recursive: true, mode: 0o700 });
  await chmod(join(stateRoot, "logs"), 0o700);
  const logPath = hostLogPath(stateRoot);
  const log = await open(logPath, "a", 0o600);
  try {
    const mainPath = fileURLToPath(new URL("./main.js", import.meta.url));
    const child = spawn(process.execPath, [mainPath, stateRoot], {
      detached: true,
      stdio: ["ignore", "pipe", log.fd],
    });
    const stdout = child.stdout;
    if (stdout === null) throw new Error("worker host spawned without a stdout pipe");

    const ready = new Promise<HostIdentity>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`worker host did not become ready; see ${logPath}`));
      }, options.readyTimeoutMs ?? 10_000);
      const settle = (): void => {
        clearTimeout(timer);
        child.off("exit", onExit);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        settle();
        reject(new Error(`worker host exited before ready (code ${code}, signal ${signal}); see ${logPath}`));
      };
      child.once("exit", onExit);
      child.once("error", (error) => {
        settle();
        reject(error);
      });
      stdout.setEncoding("utf8");
      let buffered = "";
      stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline === -1) return;
        settle();
        try {
          const line = JSON.parse(buffered.slice(0, newline)) as { identity: HostIdentity };
          resolve(line.identity);
        } catch (error) {
          reject(error);
        }
      });
    });

    try {
      return await ready;
    } catch (error) {
      // A failed start must neither leave a host behind nor hold the starter open.
      child.kill("SIGKILL");
      throw error;
    } finally {
      stdout.destroy();
      child.unref();
    }
  } finally {
    await log.close();
  }
}

/** A control connection to a running Worker Host. Closing it leaves the host running. */
export interface HostConnection {
  identify(): Promise<HostIdentity>;
  /** Starts a launch in its own process group; rejects if the host refuses. */
  launch(spec: LaunchSpec): Promise<LaunchRecord>;
  /** Every launch the host has started, with its liveness and, once gone, its exit. */
  inventory(): Promise<LaunchRecord[]>;
  /** Called for each launch exit the host reports while this connection is open. */
  onLaunchExited(listener: (launch: LaunchRecord) => void): void;
  close(): void;
}

export interface ConnectHostOptions {
  /** How long each request waits for its answer. Default 5 s. */
  readonly requestTimeoutMs?: number;
}

/** Dials the Worker Host serving `stateRoot`; rejects if none answers. */
export async function connectHost(
  stateRoot: string,
  options: ConnectHostOptions = {},
): Promise<HostConnection> {
  const socket = connect(hostSocketPath(stateRoot));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve();
    });
    socket.once("error", reject);
  });

  const pending = new Map<number, { resolve: (r: HostResponse) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const failAll = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("error", (error) => failAll(error));
  socket.on("close", () => failAll(new Error("worker host connection closed")));
  const exitListeners: Array<(launch: LaunchRecord) => void> = [];
  readLines(socket, (line) => {
    let message: HostResponse | HostEvent;
    try {
      message = JSON.parse(line) as HostResponse | HostEvent;
    } catch {
      return;
    }
    if ("event" in message) {
      if (message.event === "launch-exited") for (const listener of exitListeners) listener(message.launch);
      return;
    }
    const response = message;
    if (response.id === null) return;
    const waiter = pending.get(response.id);
    if (waiter === undefined) return;
    pending.delete(response.id);
    waiter.resolve(response);
  });

  const request = (op: HostRequest["op"], fields: Record<string, unknown> = {}): Promise<HostResponse> => {
    const id = nextId++;
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`worker host did not answer ${op} in time`));
      }, options.requestTimeoutMs ?? 5_000);
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.write(`${JSON.stringify({ ...fields, id, op })}\n`);
    });
  };

  return {
    async identify() {
      const response = await request("identify");
      if (!response.ok) throw new Error(`worker host refused identify: ${response.error}`);
      if (!("identity" in response)) throw new Error("worker host answered identify without an identity");
      if (response.identity.controlVersion !== HOST_CONTROL_VERSION) {
        throw new Error(
          `worker host control version ${response.identity.controlVersion} does not match ${HOST_CONTROL_VERSION}`,
        );
      }
      return response.identity;
    },
    async launch(spec) {
      const response = await request("launch", { spec });
      if (!response.ok) throw new Error(`worker host refused launch: ${response.error}`);
      if (!("launch" in response)) throw new Error("worker host answered launch without a launch");
      return response.launch;
    },
    async inventory() {
      const response = await request("inventory");
      if (!response.ok) throw new Error(`worker host refused inventory: ${response.error}`);
      if (!("launches" in response)) throw new Error("worker host answered inventory without launches");
      return [...response.launches];
    },
    onLaunchExited(listener) {
      exitListeners.push(listener);
    },
    close() {
      socket.end();
    },
  };
}
