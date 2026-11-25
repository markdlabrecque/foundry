// Integration tier: a real SQLite store served over a real management socket. One test proves the
// cursor contract end to end (replay after the cursor, then a live append in sequence); a second
// row checks the filters against the same boundary.
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import { openStore, serveManagementApi, storeEventSource, ticketRecord } from "@foundry/daemon";
import type { EventSource, HistoryEntry, Store } from "@foundry/daemon";
import { eventsPath, FactoryEvent } from "@foundry/protocol/management-api";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(FactoryEvent));

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const status = { instance: { stateRoot: "/fixture", daemonPid: 4242, startedAt: "2026-01-01T00:00:00.000Z" } };

/** A store and the management API over it, in a disposable root; all torn down after the test. */
const serveStore = async (
  wrap: (source: EventSource, store: Store) => EventSource = (source) => source,
): Promise<{ store: Store; socketPath: string }> => {
  const root = mkdtempSync(join(tmpdir(), "foundry-events-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(openStore({ filename: join(root, "foundry.db") }).pipe(Scope.provide(scope)));
  const events = wrap(storeEventSource(store), store);
  const api = await serveManagementApi({ stateRoot: root, status: () => status, events });
  cleanups.push(() => api.close());

  return { store, socketPath: api.socketPath };
};

const append = (store: Store, entry: HistoryEntry): Promise<number> =>
  Effect.runPromise(store.change(({ recordHistory }) => recordHistory(entry)));

/** Opens the SSE stream and collects parsed events; `next(n)` resolves once `n` have arrived. */
const openStream = (socketPath: string, path: string, headers: Record<string, string> = {}) => {
  const events: Array<FactoryEvent> = [];
  const ids: Array<string> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let ended = false;
  let response: IncomingMessage | undefined;

  const settle = () => {
    for (const w of waiters.splice(0)) {
      if (events.length >= w.count || ended) {w.resolve();}
      else {waiters.push(w);}
    }
  };

  const opened = new Promise<number>((resolve, reject) => {
    const req = request({ socketPath, path, headers }, (res) => {
      response = res;
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;

        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];

          if (id !== undefined) {ids.push(id);}

          if (data !== undefined) {events.push(decodeEvent(data));}
        }

        settle();
      });
      res.on("end", () => {
        ended = true;
        settle();
      });
      resolve(res.statusCode ?? 0);
    });

    req.on("error", reject);
    cleanups.push(() => void req.destroy());
    req.end();
  });

  return {
    opened,
    events,
    ids,
    isEnded: () => ended,
    next: (count: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
        settle();
      }),
    close: () => response?.destroy(),
  };
};

test("a followed stream replays only after the cursor, then sees one newly appended event in sequence", async () => {
  const { store, socketPath } = await serveStore();
  const first = await append(store, { factoryId: "f1", kind: "factory.started", subject: "f1" });

  const second = await append(store, {
    factoryId: "f1",
    kind: "ticket.submitted",
    subject: "t1",
    records: [ticketRecord(1)],
    detail: { title: "first" },
  });

  const third = await append(store, { factoryId: "f1", kind: "launch.started", subject: "l1" });

  // Reconnecting with the first event's ID as Last-Event-ID, which takes precedence over `since`.
  const stream = openStream(socketPath, eventsPath({ since: 0, follow: true }), { "last-event-id": String(first) });
  expect(await stream.opened).toBe(200);
  await stream.next(2);
  expect(stream.events.map((e) => [e.id, e.kind])).toEqual([
    [second, "ticket.submitted"],
    [third, "launch.started"],
  ]);
  expect(stream.events[0]).toMatchObject({
    factoryId: "f1",
    subject: "t1",
    records: [{ kind: "ticket", id: "1" }],
    detail: { title: "first" },
  });

  const fourth = await append(store, { factoryId: "f1", kind: "slot.frozen", subject: "s1" });
  await stream.next(3);
  expect(fourth).toBe(third + 1);
  expect(stream.events.map((e) => e.id)).toEqual([second, third, fourth]);
  expect(stream.ids).toEqual([second, third, fourth].map(String));
  expect(stream.events[2]).toMatchObject({ kind: "slot.frozen", subject: "s1" });
  expect(stream.isEnded()).toBe(false);
  stream.close();
});

test("an unfollowed read filters by factory and ticket, ends after replay, and refuses a bad cursor", async () => {
  const { store, socketPath } = await serveStore();
  await append(store, { factoryId: "f1", kind: "ticket.submitted", subject: "t1", records: [{ kind: "ticket", id: "1" }] });

  const wanted = await append(store, {
    factoryId: "f1",
    kind: "ticket.submitted",
    subject: "t2",
    records: [{ kind: "ticket", id: "2" }],
  });

  await append(store, { factoryId: "f2", kind: "ticket.submitted", subject: "t2", records: [{ kind: "ticket", id: "2" }] });

  const stream = openStream(socketPath, eventsPath({ factory: "f1", ticket: 2 }));
  expect(await stream.opened).toBe(200);
  await stream.next(Number.POSITIVE_INFINITY); // resolves on end
  expect(stream.isEnded()).toBe(true);
  expect(stream.events.map((e) => e.id)).toEqual([wanted]);

  const bad = openStream(socketPath, `${eventsPath({})}?since=-1`);
  expect(await bad.opened).toBe(400);
});

test("a row committed while a followed replay is being read is sent once, in sequence", async () => {
  let injected: Promise<number> | undefined;

  const { store, socketPath } = await serveStore((source, store) => ({
    ...source,
    // The first replay page is read, then a row commits before the client has seen anything.
    page: async (query) => {
      const page = await source.page(query);
      injected ??= append(store, { factoryId: "f1", kind: "launch.started", subject: "l9" });
      await injected;

      return page;
    },
  }));

  const first = await append(store, { factoryId: "f1", kind: "factory.started", subject: "f1" });
  const second = await append(store, { factoryId: "f1", kind: "launch.requested", subject: "l9" });

  const stream = openStream(socketPath, eventsPath({ follow: true }));
  expect(await stream.opened).toBe(200);
  await stream.next(3);
  const late = await append(store, { factoryId: "f1", kind: "launch.ended", subject: "l9" });
  await stream.next(4);
  expect(stream.events.map((e) => e.id)).toEqual([first, second, await injected!, late]);
  expect(late).toBe(first + 3);
  stream.close();
});

test("a client that disconnects from a followed stream stops listening for commits", async () => {
  let live = 0;
  let released: (() => void) | undefined;
  const unsubscribed = new Promise<void>((resolve) => { released = resolve; });

  const { socketPath } = await serveStore((source) => ({
    ...source,
    onCommit: (listener) => {
      live += 1;
      const off = source.onCommit(listener);

      return () => {
        off();
        live -= 1;
        released?.();
      };
    },
  }));

  const stream = openStream(socketPath, eventsPath({ follow: true }));
  expect(await stream.opened).toBe(200);
  expect(live).toBe(1);
  stream.close();
  await unsubscribed;
  expect(live).toBe(0);
});
