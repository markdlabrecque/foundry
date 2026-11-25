/**
 * The management API contract (PRD §13.1): versioned HTTP/JSON under `/api/v1/`, served by the
 * daemon on a Unix-domain socket in the state root, separate from the worker channel socket.
 * The CLI is its only client. File permissions are the only access control.
 *
 * Every response body is an envelope: `{ "ok": true, "result": ... }` on success, or
 * `{ "ok": false, "error": { "code", "message" } }` with a non-2xx HTTP status.
 */
import { join } from "node:path";
import { Schema } from "effect";

/** File name of the management socket inside the state root. */
export const MANAGEMENT_SOCKET_NAME = "management.sock";

export const managementSocketPath = (stateRoot: string): string => join(stateRoot, MANAGEMENT_SOCKET_NAME);

/** Path prefix of every route; bumped on an incompatible change. */
export const MANAGEMENT_API_PREFIX = "/api/v1";

/** `GET`: the instance status read by `foundry status`. */
export const STATUS_PATH = `${MANAGEMENT_API_PREFIX}/status`;

/** The instance the answering daemon serves. */
export const InstanceStatus = Schema.Struct({
  stateRoot: Schema.String,
  daemonPid: Schema.Number,
  /** ISO 8601 time the daemon started. */
  startedAt: Schema.String,
});

export type InstanceStatus = typeof InstanceStatus.Type;

/** Result of `GET /api/v1/status`. Later tickets add factories, slots and the rest of PRD §11.2. */
export const StatusResult = Schema.Struct({
  instance: InstanceStatus,
});

export type StatusResult = typeof StatusResult.Type;

export const ApiError = Schema.Struct({
  /** Stable, machine-readable, e.g. `not_found`. */
  code: Schema.String,
  message: Schema.String,
});

export type ApiError = typeof ApiError.Type;

export type ApiResponse<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ApiError };

/** A success envelope. `result` must be present, but its shape is the caller's to check. */
const SuccessEnvelope = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown });

const FailureEnvelope = Schema.Struct({ ok: Schema.Literal(false), error: ApiError });

const isSuccessEnvelope = Schema.is(SuccessEnvelope);

const isFailureEnvelope = Schema.is(FailureEnvelope);

/** Parses a response body into an envelope; `undefined` if it is not one. The result is not checked. */
export const parseApiResponse = (body: string): ApiResponse<unknown> | undefined => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (isSuccessEnvelope(parsed)) {return { ok: true, result: parsed.result };}

  if (isFailureEnvelope(parsed)) {
    return { ok: false, error: { code: parsed.error.code, message: parsed.error.message } };
  }

  return undefined;
};

export const isStatusResult = Schema.is(StatusResult);

/**
 * `GET`: the event stream read by `foundry events` (PRD §13.1, §15.1), as Server-Sent Events.
 * Each SSE message carries `id: <event ID>` and `data: <FactoryEvent JSON>`. Query parameters:
 * `since` (replay only events after this ID; a `Last-Event-ID` header takes precedence, so a
 * reconnecting client resumes where it stopped), `follow=1` (stay open for new events),
 * `factory` and `ticket` (filters). A refused query answers with an ordinary error envelope.
 */
export const EVENTS_PATH = `${MANAGEMENT_API_PREFIX}/events`;

/** A record a history row concerns, beyond its subject, e.g. `{ kind: "ticket", id: "42" }`. */
export const EventRecordRef = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
});

export type EventRecordRef = typeof EventRecordRef.Type;

/** One durable history row, as streamed. The ID is the row's per-instance sequence number. */
export const FactoryEvent = Schema.Struct({
  id: Schema.Number,
  factoryId: Schema.String,
  /** ISO 8601 time the change committed. */
  recordedAt: Schema.String,
  /** PRD §15.1 name, e.g. `ticket.transitioned`. */
  kind: Schema.String,
  subject: Schema.String,
  records: Schema.Array(EventRecordRef),
  detail: Schema.Unknown,
});

export type FactoryEvent = typeof FactoryEvent.Type;

export interface EventsQuery {
  /** Replay events with an ID greater than this; 0 replays everything. */
  readonly since: number;
  readonly follow: boolean;
  readonly factory: string | undefined;
  readonly ticket: number | undefined;
}

/** Builds the request path for a query. */
export const eventsPath = (query: Partial<EventsQuery>): string => {
  const params = new URLSearchParams();

  if (query.since !== undefined) {params.set("since", String(query.since));}

  if (query.follow === true) {params.set("follow", "1");}

  if (query.factory !== undefined) {params.set("factory", query.factory);}

  if (query.ticket !== undefined) {params.set("ticket", String(query.ticket));}

  const search = params.toString();

  return search === "" ? EVENTS_PATH : `${EVENTS_PATH}?${search}`;
};

const parseCount = (raw: string, min: number): number | undefined => {
  if (!/^\d+$/.test(raw)) {return undefined;}

  const value = Number(raw);

  return Number.isSafeInteger(value) && value >= min ? value : undefined;
};

const bad = (message: string) => ({ ok: false as const, error: { code: "bad_request", message } });

/** Reads an events query from the URL and the `Last-Event-ID` header. */
export const parseEventsQuery = (
  params: URLSearchParams,
  lastEventId: string | undefined,
): { readonly ok: true; readonly query: EventsQuery } | { readonly ok: false; readonly error: ApiError } => {
  let since = 0;
  const cursor = lastEventId ?? params.get("since");

  if (cursor !== null) {
    const parsed = parseCount(cursor, 0);

    if (parsed === undefined) {return bad(`event ID must be a non-negative integer, got ${JSON.stringify(cursor)}`);}

    since = parsed;
  }

  const followRaw = params.get("follow");

  if (followRaw !== null && followRaw !== "1" && followRaw !== "0") {return bad(`follow must be 1 or 0`);}

  const factory = params.get("factory") ?? undefined;

  if (factory === "") {return bad("factory must not be empty");}

  let ticket: number | undefined;
  const ticketRaw = params.get("ticket");

  if (ticketRaw !== null) {
    ticket = parseCount(ticketRaw, 1);

    if (ticket === undefined) {return bad(`ticket must be a positive integer, got ${JSON.stringify(ticketRaw)}`);}
  }

  return { ok: true, query: { since, follow: followRaw === "1", factory, ticket } };
};

export const isFactoryEvent = Schema.is(FactoryEvent);
