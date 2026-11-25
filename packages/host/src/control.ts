/**
 * The Worker Host control protocol: newline-delimited JSON over the host's
 * Unix socket in the state root. The daemon dials it; the host never dials out.
 */
import { join } from "node:path";
import { Schema } from "effect";
import type { Option } from "effect";
import type { Socket } from "node:net";
import type { LaunchRecord, LaunchSpec, Termination } from "./launches.js";

/** Bumped on any incompatible change; a mismatch is rejected, not negotiated. */
export const HOST_CONTROL_VERSION = 3 as const;

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

/**
 * Terminates one launch's process group: SIGTERM, `graceMs`, then SIGKILL and
 * up to `killWaitMs` for the group to vanish. `graceMs: 0` kills at once.
 */
export interface TerminateRequest {
  readonly id: number;
  readonly op: "terminate";
  readonly launchId: string;
  readonly graceMs?: number;
  readonly killWaitMs?: number;
}

export type HostRequest = IdentifyRequest | LaunchRequest | InventoryRequest | TerminateRequest;

export type HostResponse =
  | { readonly id: number; readonly ok: true; readonly identity: HostIdentity }
  | { readonly id: number; readonly ok: true; readonly launch: LaunchRecord }
  | { readonly id: number; readonly ok: true; readonly launches: ReadonlyArray<LaunchRecord> }
  | { readonly id: number; readonly ok: true; readonly termination: Termination }
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

const HostIdentityMessage = Schema.Struct({
  hostId: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.String,
  stateRoot: Schema.String,
  controlVersion: Schema.Number,
  bootId: Schema.String,
});

const launchFields = {
  launchId: Schema.String,
  factoryId: Schema.String,
  slotId: Schema.String,
  pid: Schema.Number,
  pgid: Schema.Number,
  bootId: Schema.String,
  startedAt: Schema.String,
};

const LaunchExitMessage = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  endedAt: Schema.String,
  requested: Schema.optionalKey(Schema.Literal(true)),
});

const LaunchRecordMessage = Schema.Union([
  Schema.Struct({ ...launchFields, liveness: Schema.Literal("live") }),
  Schema.Struct({ ...launchFields, liveness: Schema.Literal("gone"), exit: LaunchExitMessage }),
]);

const TerminationMessage = Schema.Struct({
  outcome: Schema.Literals(["gone", "unconfirmed"]),
  escalated: Schema.Boolean,
  launch: LaunchRecordMessage,
});

/** Everything the host writes on a control connection: a response or an unsolicited event. */
const HostMessage = Schema.Union([
  Schema.Struct({ event: Schema.Literal("launch-exited"), launch: LaunchRecordMessage }),
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), identity: HostIdentityMessage }),
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), launch: LaunchRecordMessage }),
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), launches: Schema.Array(LaunchRecordMessage) }),
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), termination: TerminationMessage }),
  Schema.Struct({ id: Schema.NullOr(Schema.Number), ok: Schema.Literal(false), error: Schema.String }),
]);

/** One control line from the host; `None` when it is not JSON or not a known message. */
export const decodeHostMessage: (line: string) => Option.Option<HostResponse | HostEvent> =
  Schema.decodeUnknownOption(Schema.fromJsonString(HostMessage));

/** The host's ready line on stdout; throws when it is not one. */
export const decodeReadyLine: (line: string) => { readonly identity: HostIdentity } = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ identity: HostIdentityMessage })),
);

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

      if (line.trim() !== "") {onLine(line);}

      newline = buffered.indexOf("\n");
    }
  });
}
