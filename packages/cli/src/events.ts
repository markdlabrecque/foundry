/**
 * `foundry events` (PRD §11.1, §15.1): reads the daemon's Server-Sent Events stream of durable
 * history over the management socket. Replays events after `--since`, then with `--follow` keeps
 * printing each new one. If the stream drops while following, it reconnects with the last event
 * ID it printed as `Last-Event-ID`, so nothing is missed or printed twice.
 */
import { request, type ClientRequest } from "node:http";
import { selectStateRoot } from "@foundry/protocol/state-root";
import {
  eventsPath,
  isFactoryEvent,
  managementSocketPath,
  parseApiResponse,
  type FactoryEvent,
} from "@foundry/protocol/management-api";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";

export interface EventsOptions {
  readonly json: boolean;
  readonly follow: boolean;
  readonly since: number | undefined;
  readonly ticket: number | undefined;
  readonly factory: string | undefined;
  readonly home: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Called with each line to print on stdout, as soon as it arrives. */
  readonly write: (line: string) => void;
  /** Called with a short note for stderr, e.g. when a followed stream is reconnecting. */
  readonly notice?: (line: string) => void;
  /** Aborting ends a followed stream; the command then exits 0. */
  readonly signal?: AbortSignal;
}

export interface EventsOutcome {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stderr: string;
}

/** Splits an SSE byte stream into messages. Feed it text; it returns each complete message's fields. */
export const sseParser = (): ((text: string) => Array<{ id: string | undefined; event: string; data: string }>) => {
  let buffer = "";
  return (text) => {
    buffer += text.replace(/\r\n?/g, "\n");
    const messages: Array<{ id: string | undefined; event: string; data: string }> = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let id: string | undefined;
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) messages.push({ id, event, data: data.join("\n") });
    }
    return messages;
  };
};

export const renderEvent = (event: FactoryEvent): string => {
  const records = event.records.map((r) => `${r.kind}=${r.id}`).join(" ");
  return [String(event.id), event.recordedAt, event.factoryId, event.kind, event.subject, records]
    .filter((part) => part !== "")
    .join("  ");
};

type Attempt =
  | { readonly kind: "ended" }
  | { readonly kind: "dropped" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string };

const UNREACHABLE_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

/** Base delay before reconnecting a dropped followed stream. */
const RECONNECT_DELAY_MS = 500;

export const runEvents = async (options: EventsOptions): Promise<EventsOutcome> => {
  if (options.home === "") return { exitCode: EXIT_USAGE, stderr: "foundry: --home needs a directory\n" };
  if (options.since !== undefined && options.since < 0) {
    return { exitCode: EXIT_USAGE, stderr: "foundry: --since needs a non-negative event ID\n" };
  }
  if (options.ticket !== undefined && options.ticket < 1) {
    return { exitCode: EXIT_USAGE, stderr: "foundry: --ticket needs a positive ticket number\n" };
  }
  if (options.factory === "") return { exitCode: EXIT_USAGE, stderr: "foundry: --factory needs a name\n" };
  const socketPath = managementSocketPath(selectStateRoot({ home: options.home, env: options.env }));
  let cursor = options.since ?? 0;
  let connectedOnce = false;
  let reconnecting = false;

  const attempt = (): Promise<Attempt> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (result: Attempt): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const path = eventsPath({
        since: cursor,
        follow: options.follow,
        factory: options.factory,
        ticket: options.ticket,
      });
      const req: ClientRequest = request(
        { socketPath, path, method: "GET", headers: connectedOnce ? { "last-event-id": String(cursor) } : {} },
        (res) => {
          res.setEncoding("utf8");
          if (res.statusCode !== 200) {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
              if (options.json) options.write(body.trimEnd());
              const envelope = parseApiResponse(body);
              done({
                kind: "refused",
                message:
                  envelope !== undefined && !envelope.ok
                    ? envelope.error.message
                    : `unexpected answer from ${socketPath} (HTTP ${res.statusCode})`,
              });
            });
            return;
          }
          connectedOnce = true;
          reconnecting = false;
          const parse = sseParser();
          res.on("data", (chunk: string) => {
            for (const message of parse(chunk)) {
              if (message.event === "error") {
                req.destroy();
                return done({ kind: "refused", message: `event stream failed: ${message.data}` });
              }
              let event: unknown;
              try {
                event = JSON.parse(message.data);
              } catch {
                event = undefined;
              }
              if (!isFactoryEvent(event)) {
                req.destroy();
                return done({ kind: "refused", message: "the daemon sent an event with an unexpected shape" });
              }
              options.write(options.json ? message.data : renderEvent(event));
              cursor = event.id;
            }
          });
          // `close` covers both ends: a complete one-shot response has ended; anything else dropped.
          res.on("error", () => {});
          res.on("close", () => done(res.complete && !options.follow ? { kind: "ended" } : { kind: "dropped" }));
        },
      );
      const onAbort = (): void => {
        req.destroy();
        done({ kind: "ended" });
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort);
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        if (connectedOnce && options.follow) return done({ kind: "dropped" });
        if (error.code !== undefined && UNREACHABLE_CODES.has(error.code)) {
          return done({ kind: "unreachable", message: `no daemon answers on ${socketPath} (${error.code})` });
        }
        done({ kind: "refused", message: error.message });
      });
      req.end();
    });

  for (;;) {
    const result = await attempt();
    switch (result.kind) {
      case "ended":
        return { exitCode: EXIT_OK, stderr: "" };
      case "refused":
        return { exitCode: EXIT_REFUSED, stderr: `foundry: ${result.message}\n` };
      case "unreachable":
        // Only a followed stream that has connected keeps retrying a restarting daemon.
        if (!connectedOnce || !options.follow) {
          return { exitCode: EXIT_UNREACHABLE, stderr: `foundry: daemon unreachable: ${result.message}\n` };
        }
        break;
      case "dropped":
        // A one-shot read never retries: it reports the drop and exits.
        if (!options.follow) {
          return { exitCode: EXIT_UNREACHABLE, stderr: "foundry: daemon unreachable: the event stream dropped before it ended\n" };
        }
        break;
    }
    if (options.signal?.aborted) return { exitCode: EXIT_OK, stderr: "" };
    if (!reconnecting) {
      reconnecting = true;
      options.notice?.(`foundry: event stream dropped; reconnecting after event ${cursor}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
};
