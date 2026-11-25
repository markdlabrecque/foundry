/** The Worker Host control server: serves identity, launches, inventory and termination on the host socket. */
import { randomUUID } from "node:crypto";
import { codeOf, messageOf } from "@foundry/protocol/errors";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { Option, Schema } from "effect";
import { readBootId } from "./boot.js";
import { HOST_CONTROL_VERSION, hostSocketPath, readLines } from "./control.js";
import type { HostEvent, HostIdentity, HostResponse } from "./control.js";
import { LaunchRefusedError, TerminateRefusedError, createLaunchRegistry } from "./launches.js";
import type { LaunchRecord, LaunchRegistry, TerminateOptions } from "./launches.js";
import { createHostLog, createLaunchStderrStore } from "./log.js";

/** Upper bound on a terminate's grace and kill wait, each; keeps client timers in range. */
const MAX_TERMINATE_WAIT_MS = 10 * 60_000;

const isNumber = Schema.is(Schema.Number);

const isNonEmptyText = Schema.is(Schema.NonEmptyString);

const isTextList = Schema.is(Schema.Array(Schema.String));

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const isTextRecord = Schema.is(Schema.Record(Schema.String, Schema.String));

const isWaitMs = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= MAX_TERMINATE_WAIT_MS;

/** Any request object; each op checks the fields it reads. */
const RequestFields = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  op: Schema.optionalKey(Schema.Unknown),
  spec: Schema.optionalKey(Schema.Unknown),
  launchId: Schema.optionalKey(Schema.Unknown),
  graceMs: Schema.optionalKey(Schema.Unknown),
  killWaitMs: Schema.optionalKey(Schema.Unknown),
});

const isRequestFields = Schema.is(RequestFields);

/** A launch spec's fields before they are checked, so each problem can be named. */
const SpecFields = Schema.Struct({
  factoryId: Schema.optionalKey(Schema.Unknown),
  slotId: Schema.optionalKey(Schema.Unknown),
  command: Schema.optionalKey(Schema.Unknown),
  cwd: Schema.optionalKey(Schema.Unknown),
  args: Schema.optionalKey(Schema.Unknown),
  env: Schema.optionalKey(Schema.Unknown),
});

type SpecFields = typeof SpecFields.Type;

const isSpecFields = Schema.is(SpecFields);

const isLaunchSpec = Schema.is(
  Schema.Struct({
    factoryId: Schema.NonEmptyString,
    slotId: Schema.NonEmptyString,
    command: Schema.NonEmptyString,
    cwd: Schema.NonEmptyString,
    args: Schema.Array(Schema.String),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

/**
 * A launch ends unexpectedly unless it exits on its own with code 0 or the
 * host ended it on request (`exit.requested`). Any other signal or non-zero
 * code is unexpected.
 */
export function endedUnexpectedly(launch: LaunchRecord): boolean {
  if (launch.exit === undefined || launch.exit.requested === true) {return false;}

  return launch.exit.signal !== null || launch.exit.code !== 0;
}

export interface RunningHost {
  readonly identity: HostIdentity;
  readonly socketPath: string;
  /**
   * Stops listening, drops control connections and removes the socket.
   * Launches are left running: stopping them is a separate, explicit decision.
   */
  close(): Promise<void>;
}

/** Writes one newline-terminated message, unless the client has already gone. */
const send = (socket: Socket, message: HostResponse | HostEvent): void => {
  if (socket.writable) {socket.write(`${JSON.stringify(message)}\n`);}
};

export interface ServeHostOptions {
  /**
   * Called once the host has accepted a `shutdown` request and written its answer. The process
   * entry closes the server and exits; without it the host only stops accepting launches.
   */
  readonly onShutdown?: () => void;
}

/** Serves the host control socket in `stateRoot` from the current process. */
export async function serveHost(stateRoot: string, serveOptions: ServeHostOptions = {}): Promise<RunningHost> {
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

  const log = createHostLog(identity.hostId);
  const stderrStore = createLaunchStderrStore(stateRoot);
  const clients = new Set<Socket>();
  // Set when a shutdown is accepted: from then on no launch starts, so no group can appear.
  const lifecycle = { shuttingDown: false };

  const registry = createLaunchRegistry({
    bootId,
    // An exit is reported to whoever is connected now; a client that was not
    // connected learns it from the inventory when it asks.
    onExit: (launch, stderrTail) => {
      const refs = { factoryId: launch.factoryId, slotId: launch.slotId, launchId: launch.launchId };
      const exit = { code: launch.exit?.code ?? null, signal: launch.exit?.signal ?? null };

      const report = (): void => {
        for (const client of clients) {send(client, { event: "launch-exited", launch });}
      };

      if (launch.exit?.requested === true) {
        // A host termination is an intended stop: no stderr file, no warning.
        log("info", "launch ended as requested", refs, exit);
        report();

        return;
      }

      if (!endedUnexpectedly(launch)) {
        log("info", "launch ended", refs, exit);
        report();

        return;
      }

      // The stderr file is written before the exit is reported, so a client
      // told of the exit can already find it.
      void stderrStore
        .retain(launch.factoryId, launch.slotId, launch.launchId, stderrTail)
        .then(
          (path) => log("warn", "launch ended unexpectedly", refs, { ...exit, stderr: path }),
          (cause: unknown) =>
            log("error", "launch ended unexpectedly; stderr not retained", refs, {
              ...exit,
              error: messageOf(cause),
            }),
        )
        .then(report);
    },
  });

  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    // A control client vanishing is ordinary; it must never take the host or a launch down.
    socket.on("error", () => {});
    readLines(socket, (line) => {
      // An unexpected failure answers this request; it must not take the host down.
      void answer(line, identity, registry, log, lifecycle)
        .catch((cause: unknown): HostResponse => ({
          id: requestId(line),
          ok: false,
          error: `internal error: ${messageOf(cause)}`,
        }))
        .then((response) => {
          if (!("shutdown" in response)) {
            send(socket, response);

            return;
          }

          // Answer first, so the caller learns the shutdown was accepted before the socket closes.
          if (socket.writable) {socket.write(`${JSON.stringify(response)}\n`, () => serveOptions.onShutdown?.());}
          else {serveOptions.onShutdown?.();}
        });
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
        for (const client of clients) {client.destroy();}

        server.close(() => resolve());
      })),
  };
}

async function answer(
  line: string,
  identity: HostIdentity,
  registry: LaunchRegistry,
  log: ReturnType<typeof createHostLog>,
  lifecycle: { shuttingDown: boolean },
): Promise<HostResponse> {
  let request: unknown;

  try {
    request = JSON.parse(line);
  } catch {
    return { id: null, ok: false, error: "malformed request: not JSON" };
  }

  if (!isRequestFields(request)) {
    return { id: null, ok: false, error: "malformed request: not an object" };
  }

  const { id, op, spec } = request;

  if (!isNumber(id)) {
    return { id: null, ok: false, error: "malformed request: missing numeric id" };
  }

  switch (op) {
    case "identify":
      return { id, ok: true, identity };
    case "inventory":
      return { id, ok: true, launches: registry.inventory() };
    case "launch": {
      if (!isLaunchSpec(spec)) {
        const problem = isSpecFields(spec) ? (launchSpecProblem(spec) ?? "not a launch spec") : "not an object";

        return { id, ok: false, error: `malformed launch spec: ${problem}` };
      }

      const { factoryId, slotId } = spec;

      if (lifecycle.shuttingDown) {
        log("warn", "launch refused", { factoryId, slotId }, { reason: "shutting_down" });

        return { id, ok: false, error: "the worker host is shutting down" };
      }

      try {
        const launch = await registry.launch(spec);
        log("info", "launch started", { factoryId, slotId, launchId: launch.launchId }, { pid: launch.pid });

        return { id, ok: true, launch };
      } catch (error) {
        if (error instanceof LaunchRefusedError) {
          // The code only: a spawn error's message names the command.
          log("warn", "launch refused", { factoryId, slotId }, { reason: error.code });

          return { id, ok: false, error: error.message };
        }

        throw error;
      }
    }

    case "terminate": {
      const { launchId, graceMs, killWaitMs } = request;

      if (!isNonEmptyText(launchId)) {
        return { id, ok: false, error: "malformed terminate: launchId must be a non-empty string" };
      }

      for (const [name, value] of [["graceMs", graceMs], ["killWaitMs", killWaitMs]] as const) {
        if (value !== undefined && !isWaitMs(value)) {
          return {
            id,
            ok: false,
            error: `malformed terminate: ${name} must be a number from 0 to ${MAX_TERMINATE_WAIT_MS}`,
          };
        }
      }

      const options: { -readonly [K in keyof TerminateOptions]: TerminateOptions[K] } = {};

      if (isWaitMs(graceMs)) {options.graceMs = graceMs;}

      if (isWaitMs(killWaitMs)) {options.killWaitMs = killWaitMs;}

      try {
        return { id, ok: true, termination: await registry.terminate(launchId, options) };
      } catch (error) {
        if (error instanceof TerminateRefusedError) {return { id, ok: false, error: error.message };}

        throw error;
      }
    }

    case "shutdown": {
      const occupied = registry.occupiedSlots();

      if (occupied.length > 0) {
        const named = occupied.map((slot) => `${slot.factoryId}/${slot.slotId}`).join(", ");

        return { id, ok: false, error: `shutdown refused: owned process groups not confirmed gone in ${named}` };
      }

      lifecycle.shuttingDown = true;
      log("info", "worker host shutdown accepted", {}, {});

      return { id, ok: true, shutdown: true };
    }

    default:
      return { id, ok: false, error: `unknown op: ${String(op)}` };
  }
}

const decodeRequestId = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id: Schema.Number })));

function requestId(line: string): number | null {
  return Option.getOrNull(Option.map(decodeRequestId(line), ({ id }) => id));
}

/** Names the first thing wrong with a launch spec's fields, or returns undefined. */
function launchSpecProblem(spec: SpecFields): string | undefined {
  for (const field of ["factoryId", "slotId", "command", "cwd"] as const) {
    if (!isNonEmptyText(spec[field])) {return `${field} must be a non-empty string`;}
  }

  if (!isTextList(spec.args)) {return "args must be an array of strings";}

  if (spec.env !== undefined) {
    if (!isObject(spec.env)) {return "env must be an object";}

    if (!isTextRecord(spec.env)) {return "env values must be strings";}
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

  await unlink(socketPath).catch((cause: unknown) => {
    if (codeOf(cause) !== "ENOENT") {throw cause;}
  });
}
