/**
 * The Worker Host control protocol: newline-delimited JSON over the host's
 * Unix socket in the state root. The daemon dials it; the host never dials out.
 */
import { join } from "node:path";
import type { Socket } from "node:net";
import type { LaunchRecord, LaunchSpec } from "./launches.js";

/** Bumped on any incompatible change; a mismatch is rejected, not negotiated. */
export const HOST_CONTROL_VERSION = 2 as const;

/** File name of the Worker Host's socket inside the state root. */
export const HOST_SOCKET_NAME = "host.sock";

export function hostSocketPath(stateRoot: string): string {
  return join(stateRoot, HOST_SOCKET_NAME);
}

/** Who answers on the host socket. `hostId` is fresh for every host process. */
export interface HostIdentity {
  readonly hostId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly stateRoot: string;
  readonly controlVersion: number;
  /** The machine boot this host runs in; recorded with every launch (PRD §10.2). */
  readonly bootId: string;
}

export interface IdentifyRequest {
  readonly id: number;
  readonly op: "identify";
}

export interface LaunchRequest {
  readonly id: number;
  readonly op: "launch";
  readonly spec: LaunchSpec;
}

export interface InventoryRequest {
  readonly id: number;
  readonly op: "inventory";
}

export type HostRequest = IdentifyRequest | LaunchRequest | InventoryRequest;

export type HostResponse =
  | { readonly id: number; readonly ok: true; readonly identity: HostIdentity }
  | { readonly id: number; readonly ok: true; readonly launch: LaunchRecord }
  | { readonly id: number; readonly ok: true; readonly launches: readonly LaunchRecord[] }
  | { readonly id: number | null; readonly ok: false; readonly error: string };

/**
 * Unsolicited report pushed to every connected control client. A client that
 * was not connected asks for the inventory instead; nothing is queued for it.
 */
export interface LaunchExitedEvent {
  readonly event: "launch-exited";
  readonly launch: LaunchRecord;
}

export type HostEvent = LaunchExitedEvent;

/** Calls `onLine` for every complete newline-terminated line read from `socket`. */
export function readLines(socket: Socket, onLine: (line: string) => void): void {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() !== "") onLine(line);
      newline = buffered.indexOf("\n");
    }
  });
}
