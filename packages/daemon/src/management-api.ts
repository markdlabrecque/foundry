/**
 * The management API server (PRD §13.1): HTTP/JSON on `management.sock` in the state root.
 * The only daemon module that imports `node:http`.
 *
 * Callers must hold the state-root claim (`claimStateRoot`) while serving: clearing a stale
 * socket probes and then unlinks, which is only safe with one starter per root.
 */
import { chmodSync, linkSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import {
  managementSocketPath,
  STATUS_PATH,
  type ApiError,
  type ApiResponse,
  type StatusResult,
} from "@foundry/protocol/management-api";

/** What the API reports, injected so the server is independent of where status comes from. */
export interface ManagementApiInputs {
  readonly stateRoot: string;
  /** Called on every status request, so each answer is current. */
  readonly status: () => StatusResult;
}

export interface ManagementApi {
  readonly socketPath: string;
  /** Stops listening, drops connections and removes the socket if it is still ours. Idempotent. */
  readonly close: () => Promise<void>;
}

export type ManagementSocketRefusal =
  /** A daemon already answers on the socket. */
  | "in-use"
  /** Something other than a socket is at the socket path; it is never removed. */
  | "not-a-socket"
  /** The socket exists but could not be probed. */
  | "unprobeable";

/** Refusal to serve the management API: an instance-level failure (PRD §11.6). */
export class ManagementSocketError extends Error {
  override readonly name = "ManagementSocketError";
  constructor(
    readonly reason: ManagementSocketRefusal,
    readonly socketPath: string,
    message: string,
  ) {
    super(message);
  }
}

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const lstatIfPresent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
};

const sameFile = (a: Stats | undefined, b: Stats): boolean => a !== undefined && a.dev === b.dev && a.ino === b.ino;

/**
 * Serve the management API on the state root's socket. Resolves once it accepts connections.
 *
 * A socket file nobody answers on is left by a daemon that died; it is removed. A socket that
 * answers, or a path that is not a socket, is refused and left alone.
 *
 * The socket is owner-only (0600) from the moment it is reachable: it is bound inside a private
 * 0700 directory, chmodded there, and only then hard-linked to its published path.
 */
export const serveManagementApi = async (inputs: ManagementApiInputs): Promise<ManagementApi> => {
  const socketPath = managementSocketPath(inputs.stateRoot);
  await clearStaleSocket(socketPath);

  const server = createServer((request, response) => handle(inputs, request, response));
  const privateDir = mkdtempSync(join(inputs.stateRoot, ".management-"));
  const bindPath = join(privateDir, "s");
  let published: Stats;
  try {
    await listen(server, bindPath);
    chmodSync(bindPath, 0o600);
    try {
      linkSync(bindPath, socketPath);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      throw new ManagementSocketError("in-use", socketPath, `${socketPath} appeared while the daemon was starting`);
    }
    published = lstatSync(socketPath);
  } catch (error) {
    await stop(server);
    throw error;
  } finally {
    try {
      unlinkSync(bindPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    rmdirSync(privateDir);
  }

  let closing: Promise<void> | undefined;
  return {
    socketPath,
    close: () =>
      (closing ??= stop(server).then(() => {
        // Never remove a socket someone else has since put in our place.
        if (sameFile(lstatIfPresent(socketPath), published)) unlinkSync(socketPath);
      })),
  };
};

const listen = (server: Server, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });

const stop = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

const clearStaleSocket = async (socketPath: string): Promise<void> => {
  const found = lstatIfPresent(socketPath);
  if (found === undefined) return;
  if (!found.isSocket()) {
    throw new ManagementSocketError(
      "not-a-socket",
      socketPath,
      `${socketPath} exists and is not a socket; remove it if no daemon is running`,
    );
  }
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
    throw new ManagementSocketError("in-use", socketPath, `a daemon already answers on ${socketPath}`);
  }
  if (probe instanceof Error) {
    throw new ManagementSocketError(
      "unprobeable",
      socketPath,
      `cannot tell whether a daemon answers on ${socketPath}: ${probe.message}`,
    );
  }
  // Remove only the socket we judged stale.
  if (sameFile(lstatIfPresent(socketPath), found)) unlinkSync(socketPath);
};

const handle = (inputs: ManagementApiInputs, request: IncomingMessage, response: ServerResponse): void => {
  request.resume(); // No route reads a body; drain it so the connection stays usable.
  const path = new URL(request.url ?? "/", "http://foundry").pathname;
  if (path !== STATUS_PATH) {
    return send(response, 404, failure("not_found", `no route for ${request.method} ${path}`));
  }
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    return send(response, 405, failure("method_not_allowed", `${path} only accepts GET`));
  }
  let result: StatusResult;
  try {
    result = inputs.status();
  } catch (error) {
    return send(response, 500, failure("internal", `status unavailable: ${(error as Error).message}`));
  }
  send(response, 200, { ok: true, result });
};

const failure = (code: string, message: string): ApiResponse<never> => ({ ok: false, error: { code, message } satisfies ApiError });

const send = (response: ServerResponse, status: number, body: ApiResponse<unknown>): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
};
