/**
 * Writes durable factory events to an HTTP response as Server-Sent Events (PRD §13.1, §15.1).
 *
 * Replays history after the cursor in sequence order, then, when following, sends each newly
 * committed row as it appears. The cursor only advances past rows actually sent, so a client that
 * reconnects with its last `id` as `Last-Event-ID` misses nothing and sees nothing twice.
 *
 * The no-gap guarantee relies on the store having a single writer connection and `history.sequence`
 * being AUTOINCREMENT: a row with a lower ID can never commit after a higher one has been read.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { messageOf } from "@foundry/protocol/errors";
import type { EventsQuery, FactoryEvent } from "@foundry/protocol/management-api";
import type { EventSource } from "./events.js";

/** Rows read per page, so a long replay never loads all of history at once. */
const PAGE_SIZE = 500;

/** Resolves once the response can take more data, or has closed. */
const drained = (response: ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };

    response.on("drain", done);
    response.on("close", done);
  });

/** One SSE message: the event ID as `id`, the event as one line of JSON as `data`. */
export const formatEvent = (event: FactoryEvent): string => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;

export const streamEvents = (
  source: EventSource,
  query: EventsQuery,
  request: IncomingMessage,
  response: ServerResponse,
): void => {
  let cursor = query.since;
  let closed = false;
  let pumping = false;
  let pending = false;
  // Subscribed before the first read, so a row committed during the replay is not missed.
  const unsubscribe = query.follow ? source.onCommit(() => schedule()) : () => {};

  const finish = (): void => {
    if (closed) {return;}

    closed = true;
    unsubscribe();

    if (!response.writableEnded) {response.end();}
  };

  // The response's `close` marks the client going away. The request's `close` fires as soon as its
  // (empty) body has been read, so it says nothing about the connection.
  response.on("close", finish);

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // A comment line, so the client sees the stream open before any event exists.
  response.write(": foundry events\n\n");

  const pump = async (): Promise<void> => {
    pumping = true;

    try {
      do {
        pending = false;

        for (;;) {
          const page = await source.page({ after: cursor, factory: query.factory, ticket: query.ticket, limit: PAGE_SIZE });

          if (closed) {return;}

          let full = false;

          for (const event of page) {
            if (!response.write(formatEvent(event))) {full = true;}

            cursor = event.id;
          }

          // Backpressure: a slow client holds the next page back instead of buffering history.
          if (full && !closed) {await drained(response);}

          if (closed) {return;}

          if (page.length < PAGE_SIZE) {break;}
        }
      } while (pending && !closed);
    } catch (error) {
      if (!closed) {response.write(`event: error\ndata: ${JSON.stringify({ message: messageOf(error) })}\n\n`);}

      finish();

      return;
    } finally {
      pumping = false;
    }

    if (!query.follow) {finish();}
  };

  const schedule = (): void => {
    if (closed) {return;}

    if (pumping) {
      pending = true;

      return;
    }

    void pump();
  };

  schedule();
};
