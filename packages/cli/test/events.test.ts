// Integration tier: the `foundry events` core against a real store served over a real management
// socket, in-process. The cursor and filter logic is proven in the daemon package; this proves the
// CLI's SSE client, rendering and exit codes.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import { openStore, serveManagementApi, storeEventSource, ticketRecord } from "@foundry/daemon";
import { managementSocketPath } from "@foundry/protocol/management-api";
import { EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, runEvents } from "@foundry/cli";
import type { EventsOptions } from "@foundry/cli";

const decodeEventId = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ id: Schema.Number })));

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-cli-events-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  return root;
};

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const run = async (home: string, overrides: Partial<EventsOptions> = {}) => {
  const lines: Array<string> = [];

  const outcome = await runEvents({
    json: false,
    follow: false,
    since: undefined,
    ticket: undefined,
    factory: undefined,
    home,
    env,
    write: (line) => lines.push(line),
    ...overrides,
  });

  return { ...outcome, lines };
};

test("foundry events prints history after --since, as text or JSON, and ends", async () => {
  const home = tempRoot();
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(openStore({ filename: join(home, "foundry.db") }).pipe(Scope.provide(scope)));

  const api = await serveManagementApi({
    stateRoot: home,
    status: () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } }),
    events: storeEventSource(store),
  });

  cleanups.push(() => api.close());

  const append = (kind: string, subject: string, ticket?: string) =>
    Effect.runPromise(
      store.change(({ recordHistory }) =>
        recordHistory(
          ticket === undefined
            ? { factoryId: "f1", kind, subject }
            : { factoryId: "f1", kind, subject, records: [ticketRecord(Number(ticket))] },
        ),
      ),
    );

  const first = await append("factory.started", "f1");
  const second = await append("ticket.submitted", "t7", "7");

  const text = await run(home, { since: first });
  expect(text.exitCode).toBe(EXIT_OK);
  expect(text.lines).toHaveLength(1);
  expect(text.lines[0]).toMatch(new RegExp(`^${second}  \\S+  f1  ticket\\.submitted  t7  ticket=7$`));

  const json = await run(home, { json: true });
  expect(json.exitCode).toBe(EXIT_OK);
  expect(json.lines.map((line) => decodeEventId(line).id)).toEqual([first, second]);
});

test("foundry events refuses bad arguments and reports an absent daemon as unreachable", async () => {
  const home = tempRoot();
  expect((await run(home, { since: -1 })).exitCode).toBe(EXIT_USAGE);
  expect((await run(home, { ticket: 0 })).exitCode).toBe(EXIT_USAGE);
  const absent = await run(home, { follow: true });
  expect(absent.exitCode).toBe(EXIT_UNREACHABLE);
  expect(absent.stderr).toContain("daemon unreachable");
});

test("a one-shot read whose stream drops exits as unreachable instead of retrying", async () => {
  const home = tempRoot();
  // Stands in for a daemon that dies mid-stream: one event, then the connection is cut.
  let requests = 0;

  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = { id: 1, factoryId: "f1", recordedAt: "2026-01-01T00:00:00.000Z", kind: "factory.started", subject: "f1", records: [], detail: null };
    res.write(`id: 1\ndata: ${JSON.stringify(event)}\n\n`, () => res.socket?.destroy());
  });

  cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  await new Promise<void>((done) => { server.listen(managementSocketPath(home), done); });

  const dropped = await run(home);
  expect(dropped.exitCode).toBe(EXIT_UNREACHABLE);
  expect(dropped.lines).toHaveLength(1);
  expect(requests).toBe(1);
});
