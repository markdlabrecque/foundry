/**
 * HTTP routing for the ticket routes of the management API (`@foundry/protocol/tickets-api`).
 * Kept apart from `management-api.ts` so it stays the socket's lifecycle and the status route.
 */
import type { IncomingMessage } from "node:http";
import { Cause, Effect, Exit } from "effect";
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (record: Record<string, unknown>, key: string): string | undefined | false => {
  const value = record[key];

  if (value === undefined) {return undefined;}

  return typeof value === "string" && value !== "" ? value : false;
};

/** Checks a submit body's shape; returns a message on failure. */
const parseSubmit = (text: string): SubmitTicketRequest | string => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return "the request body is not JSON";
  }

  if (!isRecord(parsed)) {return "the request body must be a JSON object";}

  if (typeof parsed["title"] !== "string") {return "title must be a string";}

  if (typeof parsed["spec"] !== "string") {return "spec must be a string";}

  const factory = optionalString(parsed, "factory");
  const line = optionalString(parsed, "line");

  if (factory === false) {return "factory must be a non-empty string";}

  if (line === false) {return "line must be a non-empty string";}

  return {
    title: parsed["title"],
    spec: parsed["spec"],
    ...(factory === undefined ? {} : { factory }),
    ...(line === undefined ? {} : { line }),
  };
};

const run = async <A>(effect: Effect.Effect<A, unknown>, okStatus: number): Promise<RouteReply> => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {return { status: okStatus, body: { ok: true, result: exit.value } };}

  const error = Cause.squash(exit.cause);

  if (error instanceof TicketError) {return fail(STATUS_OF[error.code], error.code, error.message);}

  return fail(500, "internal", error instanceof Error ? error.message : String(error));
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

      if (typeof submit === "string") {return fail(400, "invalid_request", submit);}

      return run(tickets.submit(submit), 201);
    }

    request.resume();

    return { ...fail(405, "method_not_allowed", `${TICKETS_PATH} only accepts GET and POST`), allow: "GET, POST" };
  }

  request.resume();
  const match = /^\/([1-9][0-9]{0,8})$/.exec(rest);

  if (match === null) {return fail(404, "not_found", `no route for ${request.method} ${url.pathname}`);}

  if (request.method !== "GET") {
    return { ...fail(405, "method_not_allowed", `${url.pathname} only accepts GET`), allow: "GET" };
  }

  return run(tickets.show(factory, Number(match[1])), 200);
};
