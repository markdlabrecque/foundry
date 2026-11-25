/**
 * The management API contract (PRD §13.1): versioned HTTP/JSON under `/api/v1/`, served by the
 * daemon on a Unix-domain socket in the state root, separate from the worker channel socket.
 * The CLI is its only client. File permissions are the only access control.
 *
 * Every response body is an envelope: `{ "ok": true, "result": ... }` on success, or
 * `{ "ok": false, "error": { "code", "message" } }` with a non-2xx HTTP status.
 */
import { join } from "node:path";

/** File name of the management socket inside the state root. */
export const MANAGEMENT_SOCKET_NAME = "management.sock";

export const managementSocketPath = (stateRoot: string): string => join(stateRoot, MANAGEMENT_SOCKET_NAME);

/** Path prefix of every route; bumped on an incompatible change. */
export const MANAGEMENT_API_PREFIX = "/api/v1";

/** `GET`: the instance status read by `foundry status`. */
export const STATUS_PATH = `${MANAGEMENT_API_PREFIX}/status`;

/** The instance the answering daemon serves. */
export interface InstanceStatus {
  readonly stateRoot: string;
  readonly daemonPid: number;
  /** ISO 8601 time the daemon started. */
  readonly startedAt: string;
}

/** Result of `GET /api/v1/status`. Later tickets add factories, slots and the rest of PRD §11.2. */
export interface StatusResult {
  readonly instance: InstanceStatus;
}

export interface ApiError {
  /** Stable, machine-readable, e.g. `not_found`. */
  readonly code: string;
  readonly message: string;
}

export type ApiResponse<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ApiError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a response body into an envelope; `undefined` if it is not one. The result is not checked. */
export const parseApiResponse = (body: string): ApiResponse<unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed["ok"] === true && "result" in parsed) return { ok: true, result: parsed["result"] };
  const error = parsed["error"];
  if (parsed["ok"] === false && isRecord(error) && typeof error["code"] === "string" && typeof error["message"] === "string") {
    return { ok: false, error: { code: error["code"], message: error["message"] } };
  }
  return undefined;
};

export const isStatusResult = (value: unknown): value is StatusResult => {
  if (!isRecord(value) || !isRecord(value["instance"])) return false;
  const { stateRoot, daemonPid, startedAt } = value["instance"];
  return typeof stateRoot === "string" && typeof daemonPid === "number" && typeof startedAt === "string";
};
