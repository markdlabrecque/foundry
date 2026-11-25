// Integration tier: the ticket routes on a real management socket over a real SQLite file and
// ticket directories, all in a disposable temp dir. Reopening closes both and starts again.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  DATABASE_FILE_NAME,
  makeTicketService,
  openStore,
  serveManagementApi,
  slugify,
  ticketDirectory,
  type TicketFactory,
} from "@foundry/daemon";
import { TICKETS_PATH, ticketPath } from "@foundry/protocol/tickets-api";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-tickets-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const shop: TicketFactory = {
  name: "shop",
  defaultLine: "standard",
  messageBudget: 100,
  lines: { standard: { rejectionLimit: 3 }, hotfix: { rejectionLimit: 1 } },
};
const blog: TicketFactory = { name: "blog", defaultLine: "standard", messageBudget: 50, lines: { standard: { rejectionLimit: 2 } } };

const status = () => ({ instance: { stateRoot: "/fixture", daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } });

/** A daemon's store and API on `root`; `stop` closes both, as a daemon stopping would. */
const start = async (root: string, factories: ReadonlyArray<TicketFactory>) => {
  const scope = await Effect.runPromise(Scope.make());
  let stopped = false;
  const stopStore = () => (stopped ? Promise.resolve() : ((stopped = true), Effect.runPromise(Scope.close(scope, Exit.void))));
  cleanups.push(stopStore); // Registered before anything can fail.
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(root, DATABASE_FILE_NAME) })));
  const api = await serveManagementApi({
    stateRoot: root,
    status,
    tickets: makeTicketService({ stateRoot: root, store, factories: () => factories }),
  });
  cleanups.push(() => api.close());
  return {
    store,
    call: (method: string, path: string, body?: unknown) => call(api.socketPath, method, path, body),
    stop: async () => {
      await api.close();
      await stopStore();
    },
  };
};

const call = (socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    // agent: false — a pooled keep-alive socket would outlive the daemon a test restarts on the same path.
    const req = request({ socketPath, path, method, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });

const SPEC = "# Add a password reset\n\n## Objective\nLet users reset passwords.\n";

test("submitted tickets, their transitions and ticket directories survive a daemon restart", async () => {
  const root = tempRoot();
  const first = await start(root, [shop]);

  const submitted = await first.call("POST", TICKETS_PATH, { title: "Add a password reset", spec: SPEC });
  expect(submitted.status).toBe(201);
  const hotfix = await first.call("POST", TICKETS_PATH, { title: "Fix: crash!", spec: "x", line: "hotfix" });
  expect(hotfix.status).toBe(201);
  await first.stop();

  const second = await start(root, [shop]);
  const list = await second.call("GET", TICKETS_PATH);
  expect(list).toMatchObject({
    status: 200,
    body: {
      ok: true,
      result: {
        tickets: [
          { factory: "shop", number: 1, title: "Add a password reset", slug: "add-a-password-reset", line: "standard", state: "backlog", stage: null, status: null },
          { factory: "shop", number: 2, slug: "fix-crash", line: "hotfix", state: "backlog" },
        ],
      },
    },
  });

  const shown = await second.call("GET", ticketPath(1));
  expect(shown.status).toBe(200);
  const { ticket, transitions } = shown.body.result;
  const directory = ticketDirectory(root, "shop", 1);
  expect(ticket).toMatchObject({
    directory,
    specPath: join(directory, "spec.md"),
    evidencePath: join(directory, "evidence"),
    rejections: { spent: 0, ceiling: 3 },
    messages: { spent: 0, ceiling: 100 },
    worktree: null,
  });
  expect(transitions).toMatchObject([{ actor: "operator", from: null, to: { state: "backlog", stage: null, status: null } }]);
  expect(readFileSync(ticket.specPath, "utf8")).toBe(SPEC);
  expect(statSync(ticket.evidencePath).isDirectory()).toBe(true);
  expect(readdirSync(ticket.evidencePath)).toEqual([]);

  const history = await Effect.runPromise(second.store.read(`SELECT factory_id, kind, subject FROM history ORDER BY sequence`));
  expect(history).toEqual([
    { factory_id: "shop", kind: "ticket.submitted", subject: "1" },
    { factory_id: "shop", kind: "ticket.submitted", subject: "2" },
  ]);
});

test("an unknown production line is refused and writes no ticket, transition, history or directory", async () => {
  const root = tempRoot();
  const daemon = await start(root, [shop]);

  const refused = await daemon.call("POST", TICKETS_PATH, { title: "T", spec: SPEC, line: "nope" });
  expect(refused).toMatchObject({ status: 400, body: { ok: false, error: { code: "unknown_line" } } });
  expect(refused.body.error.message).toContain("standard, hotfix");

  const counts = await Effect.runPromise(
    daemon.store.read(
      `SELECT (SELECT count(*) FROM ticket) AS tickets, (SELECT count(*) FROM ticket_transition) AS transitions,
              (SELECT count(*) FROM history) AS history`,
    ),
  );
  expect(counts).toEqual([{ tickets: 0, transitions: 0, history: 0 }]);
  expect(existsSync(join(root, "tickets"))).toBe(false);

  // The refused request did not consume a number.
  const next = await daemon.call("POST", TICKETS_PATH, { title: "T", spec: SPEC });
  expect(next.body.result.ticket.number).toBe(1);
});

test("with two factories loaded, submit and show need one named and numbers are per factory", async () => {
  const root = tempRoot();
  const daemon = await start(root, [shop, blog]);

  expect(await daemon.call("POST", TICKETS_PATH, { title: "T", spec: "x" })).toMatchObject({
    status: 400,
    body: { error: { code: "factory_required" } },
  });
  expect(await daemon.call("POST", TICKETS_PATH, { title: "T", spec: "x", factory: "nope" })).toMatchObject({
    status: 404,
    body: { error: { code: "unknown_factory" } },
  });
  await daemon.call("POST", TICKETS_PATH, { title: "S", spec: "x", factory: "shop" });
  const b = await daemon.call("POST", TICKETS_PATH, { title: "B", spec: "y", factory: "blog" });
  expect(b.body.result.ticket).toMatchObject({ factory: "blog", number: 1, messages: { ceiling: 50 } });
  expect(b.body.result.ticket.directory).not.toBe(ticketDirectory(root, "shop", 1));

  expect((await daemon.call("GET", `${TICKETS_PATH}?factory=blog`)).body.result.tickets).toMatchObject([{ factory: "blog", title: "B" }]);
  expect((await daemon.call("GET", TICKETS_PATH)).body.result.tickets).toHaveLength(2);
  expect(await daemon.call("GET", ticketPath(1))).toMatchObject({ status: 400, body: { error: { code: "factory_required" } } });
  expect(await daemon.call("GET", `${ticketPath(2)}?factory=shop`)).toMatchObject({
    status: 404,
    body: { error: { code: "ticket_not_found" } },
  });
});

test("malformed submit requests are refused before anything is written", async () => {
  const root = tempRoot();
  const daemon = await start(root, [shop]);
  const cases: Array<[unknown, string]> = [
    ["not json", "invalid_request"],
    [[], "invalid_request"],
    [{ spec: "x" }, "invalid_request"],
    [{ title: "T" }, "invalid_request"],
    [{ title: "  ", spec: "x" }, "invalid_request"],
    [{ title: "a\nb", spec: "x" }, "invalid_request"],
    [{ title: "T", spec: "x", line: "" }, "invalid_request"],
  ];
  for (const [body, code] of cases) {
    expect(await daemon.call("POST", TICKETS_PATH, body), JSON.stringify(body)).toMatchObject({
      status: 400,
      body: { ok: false, error: { code } },
    });
  }
  expect((await daemon.call("DELETE", TICKETS_PATH)).status).toBe(405);
  expect((await daemon.call("GET", `${TICKETS_PATH}/0`)).status).toBe(404);
  expect((await daemon.call("GET", TICKETS_PATH)).body.result.tickets).toEqual([]);
});

test("slugs are lowercase ASCII words joined by hyphens", () => {
  expect(slugify("Add a Password Reset")).toBe("add-a-password-reset");
  expect(slugify("  Café — déjà vu!! ")).toBe("cafe-deja-vu");
  expect(slugify("!!!")).toBe("ticket");
  expect(slugify("a".repeat(60))).toHaveLength(48);
});
