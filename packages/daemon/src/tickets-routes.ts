/**
 * HTTP routing for the ticket routes of the management API (`@foundry/protocol/tickets-api`).
 * Kept apart from `management-api.ts` so it stays the socket's lifecycle and the status route.
 */
import type { IncomingMessage } from "node:http";
import { Cause, Effect, Exit, Match, Schema } from "effect";
import { messageOf } from "@foundry/protocol/errors";
import type { ApiResponse } from "@foundry/protocol/management-api";
import { FACTORY_PARAM, TICKETS_PATH } from "@foundry/protocol/tickets-api";
import type { SubmitTicketRequest } from "@foundry/protocol/tickets-api";
import { TicketError } from "./tickets.js";
import type { TicketErrorCode, TicketService } from "./tickets.js";

export interface RouteReply {
  readonly status: number;
  readonly body: ApiResponse<unknown>;
  readonly allow?: string;
}

/** Largest accepted request body; a specification is a Markdown file. */
const BODY_LIMIT = 1024 * 1024;

const STATUS_OF: Record<TicketErrorCode, number> = {
  invalid_request: 400,
  factory_required: 400,
  unknown_factory: 404,
  unknown_line: 400,
  ticket_not_found: 404,
  invalid_state: 409,
  unavailable: 503,
  no_live_launch: 409,
  channel_unavailable: 503,
  interrupt_unacknowledged: 504,
  internal: 500,
};

const fail = (status: number, code: string, message: string): RouteReply => ({
  status,
  body: { ok: false, error: { code, message } },
});

class BodyError extends Error {}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);

      if (size > BODY_LIMIT) {
        request.removeAllListeners("data");
        request.resume();
        reject(new BodyError(`request body exceeds ${BODY_LIMIT} bytes`));

        return;
      }

      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

/** A submit body's fields before they are checked, so each problem can be named. */
const isSubmitFields = Schema.is(
  Schema.Struct({
    title: Schema.optionalKey(Schema.Unknown),
    spec: Schema.optionalKey(Schema.Unknown),
    factory: Schema.optionalKey(Schema.Unknown),
    line: Schema.optionalKey(Schema.Unknown),
  }),
);

const isText = Schema.is(Schema.String);

const isNonEmptyText = Schema.is(Schema.NonEmptyString);

const isRefusal = Schema.is(Schema.String);

/** Checks a submit body's shape; returns a message on failure. */
const parseSubmit = (text: string): SubmitTicketRequest | string => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return "the request body is not JSON";
  }

  if (!isSubmitFields(parsed)) {return "the request body must be a JSON object";}

  const { title, spec } = parsed;

  if (!isText(title)) {return "title must be a string";}

  if (!isText(spec)) {return "spec must be a string";}

  // Optional fields: absent, a non-empty string, or `false` when they are anything else.
  const factory = parsed.factory === undefined ? undefined : isNonEmptyText(parsed.factory) ? parsed.factory : false;
  const line = parsed.line === undefined ? undefined : isNonEmptyText(parsed.line) ? parsed.line : false;

  if (factory === false) {return "factory must be a non-empty string";}

  if (line === false) {return "line must be a non-empty string";}

  let request: SubmitTicketRequest = { title, spec };

  if (factory !== undefined) {request = { ...request, factory };}

  if (line !== undefined) {request = { ...request, line };}

  return request;
};

const run = async <A>(effect: Effect.Effect<A, unknown>, okStatus: number): Promise<RouteReply> => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {return { status: okStatus, body: { ok: true, result: exit.value } };}

  const error = Cause.squash(exit.cause);

  if (error instanceof TicketError) {return fail(STATUS_OF[error.code], error.code, error.message);}

  return fail(500, "internal", messageOf(error));
};

/** Answers one request under `/api/v1/tickets`. */
export const handleTickets = async (tickets: TicketService, request: IncomingMessage, url: URL): Promise<RouteReply> => {
  const factoryParam = url.searchParams.get(FACTORY_PARAM);
  const factory = factoryParam === null || factoryParam === "" ? undefined : factoryParam;
  const rest = url.pathname.slice(TICKETS_PATH.length);

  if (rest === "") {
    if (request.method === "GET") {
      request.resume();

      return run(tickets.list(factory), 200);
    }

    if (request.method === "POST") {
      let text: string;

      try {
        text = await readBody(request);
      } catch (error) {
        if (error instanceof BodyError) {return fail(413, "invalid_request", error.message);}

        throw error;
      }

      const submit = parseSubmit(text);

      if (isRefusal(submit)) {return fail(400, "invalid_request", submit);}

      return run(tickets.submit(submit), 201);
    }

    request.resume();

    return { ...fail(405, "method_not_allowed", `${TICKETS_PATH} only accepts GET and POST`), allow: "GET, POST" };
  }

  const cancellation = /^\/([1-9][0-9]{0,8})\/cancel$/.exec(rest);

  if (cancellation !== null) {
    const number = Number(cancellation[1]);

    if (request.method === "GET") {
      request.resume();

      return run(tickets.inspectCancellation(factory, number), 200);
    }

    if (request.method === "POST") {
      try {
        const parsed: unknown = JSON.parse(await readBody(request));
        const isConfirmation = Schema.is(Schema.Struct({ confirmation: Schema.NonEmptyString }));

        if (!isConfirmation(parsed)) {return fail(400, "invalid_request", "cancellation needs the inspected confirmation");}

        return await run(tickets.cancel(factory, number, parsed.confirmation), 200);
      } catch (error) {
        return fail(error instanceof BodyError ? 413 : 400, "invalid_request", "invalid cancellation body");
      }
    }

    request.resume();

    return { ...fail(405, "method_not_allowed", `${url.pathname} only accepts GET and POST`), allow: "GET, POST" };
  }

  request.resume();
  const action = /^\/([1-9][0-9]{0,8})\/(pause|resume|retry)$/.exec(rest);

  if (action !== null) {
    if (request.method !== "POST") {
      return { ...fail(405, "method_not_allowed", `${url.pathname} only accepts POST`), allow: "POST" };
    }

    const perform = Match.value(action[2]).pipe(
      Match.when("retry", () => tickets.retry),
      Match.when("resume", () => tickets.resume),
      Match.orElse(() => tickets.pause),
    );

    return run(perform(factory, Number(action[1])), 200);
  }

  const match = /^\/([1-9][0-9]{0,8})$/.exec(rest);

  if (match === null) {return fail(404, "not_found", `no route for ${request.method} ${url.pathname}`);}

  if (request.method !== "GET") {
    return { ...fail(405, "method_not_allowed", `${url.pathname} only accepts GET`), allow: "GET" };
  }

  return run(tickets.show(factory, Number(match[1])), 200);
};
