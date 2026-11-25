/**
 * The Worker Host control protocol: newline-delimited JSON over the host's
 * Unix socket in the state root. The daemon dials it; the host never dials out.
 */
import { join } from "node:path";
import type { Socket } from "node:net";

/** Bumped on any incompatible change; a mismatch is rejected, not negotiated. */
export const HOST_CONTROL_VERSION = 1 as const;

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
}

export interface IdentifyRequest {
  readonly id: number;
  readonly op: "identify";
}

export type HostRequest = IdentifyRequest;

export type HostResponse =
  | { readonly id: number; readonly ok: true; readonly identity: HostIdentity }
  | { readonly id: number | null; readonly ok: false; readonly error: string };

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
