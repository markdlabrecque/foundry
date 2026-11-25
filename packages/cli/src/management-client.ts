/**
 * The CLI's management API client: one HTTP request over the state root's Unix socket.
 * The only CLI module that imports `node:http`. The CLI never opens the database (ADR 0001).
 */
import { request } from "node:http";
import { managementSocketPath, parseApiResponse, type ApiResponse } from "@foundry/protocol/management-api";

/** The daemon could not be reached: no socket, nobody answering, or no answer in time. */
export class DaemonUnreachableError extends Error {
  override readonly name = "DaemonUnreachableError";
}

/** What came back from the daemon: the raw body (printed unchanged by `--json`) and its envelope. */
export interface ApiReply {
  readonly status: number;
  readonly body: string;
  readonly envelope: ApiResponse<unknown>;
}

export interface GetOptions {
  /** Default 5 s. */
  readonly timeoutMs?: number;
}

const UNREACHABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);

/** `GET path` from the daemon serving `stateRoot`. */
export const getFromDaemon = (stateRoot: string, path: string, options: GetOptions = {}): Promise<ApiReply> => {
  const socketPath = managementSocketPath(stateRoot);
  return new Promise<ApiReply>((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", timeout: options.timeoutMs ?? 5_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("error", reject);
      res.on("end", () => {
        const envelope = parseApiResponse(body);
        if (envelope === undefined) {
          reject(new Error(`unexpected answer from ${socketPath} (HTTP ${res.statusCode})`));
          return;
        }
        resolve({ status: res.statusCode ?? 0, body, envelope });
      });
    });
    req.on("timeout", () => req.destroy(new DaemonUnreachableError(`no answer on ${socketPath} in time`)));
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error instanceof DaemonUnreachableError) return reject(error);
      if (error.code !== undefined && UNREACHABLE_CODES.has(error.code)) {
        return reject(new DaemonUnreachableError(`no daemon answers on ${socketPath} (${error.code})`));
      }
      reject(error);
    });
    req.end();
  });
};
