// Integration tier: CLI -> management socket -> real disposable SQLite, reopened after acceptance.
// This single boundary smoke also proves attribution cannot be supplied by the HTTP caller.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { createOperatorMessages, foundryMigrations, openStore, serveManagementApi } from "@foundry/daemon";
import type { PlannedSlot, Store } from "@foundry/daemon";
import { runMessageSend, runMessageDisposition } from "@foundry/cli";
import { postToDaemon } from "../src/management-client.js";
import { MESSAGES_PATH } from "@foundry/protocol/messages-api";
import type { MessageDispositionResult } from "@foundry/protocol/messages-api";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();} });

const tempRoot = () => {
  const home = mkdtempSync(join(tmpdir(), "foundry-msg-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));

  return home;
};

const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const station = (factoryId: string, address: string): PlannedSlot => ({
  factoryId, slotId: "builder/1", ordinal: 1,
  station: { address, room: "eng", station: "builder", instructions: [], model: "faux/scripted",
    skills: [], extensions: [], instances: 1, isolation: "none" },
});

const open = async (home: string) => {
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  cleanups.push(close);
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(home, "foundry.db") })));

  return { store, close };
};

const rows = (store: Store) => Effect.runPromise(store.read<{ sequence: number; delivery: string }>(`SELECT * FROM message ORDER BY sequence`));

test("operator sends commit in the shared log with operator attribution, no assignment/budget, and survive reopen", async () => {
  const home = tempRoot();
  const { store, close } = await open(home);
  let factories = ["shop"];

  const messages = createOperatorMessages({
    store, factories: () => factories, slots: [station("shop", "eng.builder"), station("other", "ops.deployer")],
    guards: {
      assignmentTicket: () => Effect.die("operator sends must not read a slot assignment"),
      budget: () => Effect.die("operator sends must not spend budget"),
    },
  });

  const api = await serveManagementApi({ stateRoot: home, messages,
    status: () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-01-01T00:00:00Z" } }),
  });

  cleanups.push(api.close);
  const common = { json: false, home, factory: undefined, env, recipient: "eng.builder", body: "Hello\n✓", delivery: undefined };
  expect(await runMessageSend(common)).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("accepted in shop (#1)") });

  const spoof = await postToDaemon(home, MESSAGES_PATH, { recipient: "eng.builder", body: "second", delivery: "when_idle",
    senderKind: "agent", senderSlot: "builder/1", factoryId: "other", kind: "reply", ticket: 42, requestId: "spoof" });

  expect(spoof.status).toBe(201);
  expect(spoof.envelope).toMatchObject({ ok: true, result: { senderKind: "operator", senderSlot: null, kind: "ordinary",
    ticket: null, requestId: null, delegationId: null, factoryId: "shop", sequence: 2 } });
  expect((await runMessageSend({ ...common, recipient: "ops.deployer" })).exitCode).toBe(1);
  expect((await runMessageSend({ ...common, factory: "missing" })).exitCode).toBe(1);
  factories = ["shop", "other"];
  expect((await runMessageSend(common)).exitCode).toBe(1);
  const explicit = await runMessageSend({ ...common, factory: "shop", json: true });
  expect(explicit.exitCode).toBe(0);
  expect(JSON.parse(explicit.stdout)).toMatchObject({ ok: true, result: { sequence: 3 } });

  for (const invalid of [{ recipient: "eng.builder", body: "x", delivery: "urgent" }, { recipient: "eng.builder", body: 5 },
    { recipient: "eng.builder", body: "x", factory: "" }]) {
    expect((await postToDaemon(home, MESSAGES_PATH, invalid)).status).toBe(400);
  }

  expect(await rows(store)).toHaveLength(3);
  await api.close();
  await close();
  const reopened = await open(home);
  expect(await rows(reopened.store)).toMatchObject([
    { sender_kind: "operator", sender_slot: null, body: common.body, delivery: "after_turn", ticket_number: null, status: "unbound" },
    { sender_kind: "operator", sender_slot: null, delivery: "when_idle", sequence: 2 }, { sequence: 3 },
  ]);
  expect(await Effect.runPromise(reopened.store.read(`SELECT kind, detail FROM history ORDER BY sequence`)))
    .toEqual((await rows(reopened.store)).map((row) => ({ kind: "message.accepted", detail: JSON.stringify({
      sequence: row.sequence, senderKind: "operator", senderSlot: null,
      recipient: "eng.builder", kind: "ordinary", delivery: row.delivery,
    }) })));
});

test("migration preserves request, assignment and delivery references, bindings, acknowledgements and daemon attribution", async () => {
  const home = tempRoot();
  const filename = join(home, "foundry.db");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* openStore({ filename, migrations: foundryMigrations.filter((m) => m.id <= 16) });
    yield* store.change((change) => Effect.gen(function* () {
      yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition)
        VALUES ('shop', 'builder/1', 'builder', 1, 'normal')`);
      yield* change.query(`INSERT INTO ticket (factory_id, number, title, slug, production_line, directory, state,
        rejection_ceiling, message_ceiling, submitted_at)
        VALUES ('shop', 1, 'Ticket', 'ticket', 'standard', '/disposable', 'backlog', 3, 10, 1)`);
      yield* change.query(`INSERT INTO message (id, factory_id, sequence, sender_slot, recipient, body, delivery, kind,
        ticket_number, request_id, status, accepted_at, bound_slot, bound_at)
        VALUES ('old', 'shop', 1, 'builder/1', 'eng.builder', 'retained', 'after_turn', 'request_notice',
          1, 'request', 'bound', 1, 'builder/1', 2),
        ('context', 'shop', 2, '', 'eng.builder', 'context body', 'after_turn', 'ordinary',
          1, NULL, 'bound', 1, 'builder/1', 2),
        ('queued', 'shop', 3, 'builder/1', 'eng.builder', 'queued body', 'when_idle', 'ordinary',
          NULL, NULL, 'unbound', 1, NULL, NULL)`);
      yield* change.query(`INSERT INTO message (id, factory_id, sequence, sender_slot, recipient, body, delivery, kind,
        status, accepted_at, bound_slot, bound_at, acknowledged_at)
        VALUES ('delivered', 'shop', 4, 'builder/1', 'eng.builder', 'delivered body', 'after_turn', 'ordinary',
          'acknowledged', 1, 'builder/1', 2, 123)`);
      yield* change.query(`INSERT INTO message_attempt (id, factory_id, message_id, slot_id, launch_id,
        connection_id, sent_at, acknowledged_at)
        VALUES ('attempt', 'shop', 'delivered', 'builder/1', 'launch', 'connection', 3, 123)`);
      yield* change.query(`INSERT INTO agent_request (id, factory_id, requester_slot, recipient, ticket_number,
        notice_id, status, accepted_at, deadline)
        VALUES ('request', 'shop', 'builder/1', 'eng.builder', 1, 'old', 'open', 1, 1000)`);
      yield* change.query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status,
        recovery_ceiling, created_at, context_message)
        VALUES ('assignment', 'shop', 1, 'plan', 'builder/1', 'active', 3, 1, 'context')`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "upgrade" });
    }));
  })));
  const { store } = await open(home);
  expect(await rows(store)).toMatchObject([
    { id: "old", sender_kind: "agent", sender_slot: "builder/1", body: "retained", request_id: "request",
      ticket_number: 1, status: "bound", bound_slot: "builder/1", bound_at: 2 },
    { id: "context", sender_kind: "daemon", sender_slot: null, body: "context body", ticket_number: 1,
      status: "bound", bound_slot: "builder/1", bound_at: 2 },
    { id: "queued", sender_kind: "agent", status: "unbound", bound_slot: null, delivery: "when_idle" },
    { id: "delivered", sender_kind: "agent", sender_slot: "builder/1", body: "delivered body", status: "acknowledged",
      bound_slot: "builder/1", bound_at: 2, acknowledged_at: 123 },
  ]);
  expect(await Effect.runPromise(store.read(`SELECT notice_id FROM agent_request`))).toEqual([{ notice_id: "old" }]);
  expect(await Effect.runPromise(store.read(`SELECT context_message FROM assignment`))).toEqual([{ context_message: "context" }]);
  expect(await Effect.runPromise(store.read(`SELECT message_id, sent_at, acknowledged_at FROM message_attempt`)))
    .toEqual([{ message_id: "delivered", sent_at: 3, acknowledged_at: 123 }]);
  expect(await Effect.runPromise(store.read(`PRAGMA foreign_key_check`))).toEqual([]);
  expect(await Effect.runPromise(store.read(`PRAGMA foreign_key_list(agent_request)`)))
    .toEqual(expect.arrayContaining([expect.objectContaining({ table: "message", from: "notice_id", to: "id" })]));
  expect(await Effect.runPromise(store.read(`PRAGMA foreign_key_list(assignment)`)))
    .toEqual(expect.arrayContaining([expect.objectContaining({ table: "message", from: "context_message", to: "id" })]));
  expect(await Effect.runPromise(store.read(`PRAGMA foreign_key_list(message_attempt)`)))
    .toEqual(expect.arrayContaining([expect.objectContaining({ table: "message", from: "message_id", to: "id" })]));
  expect(await Effect.runPromise(store.read(`SELECT name, sql FROM sqlite_master WHERE name = 'message_unbound'`)))
    .toEqual([{ name: "message_unbound", sql: "CREATE INDEX message_unbound ON message (factory_id, sequence) WHERE status = 'unbound'" }]);

  // Both the immutable binding trigger and parent FKs still actively reject invalid mutations.
  for (const sql of [
    `UPDATE message SET bound_slot = 'builder/2' WHERE id = 'old'`,
    `DELETE FROM message WHERE id = 'old'`,
    `DELETE FROM message WHERE id = 'context'`,
    `DELETE FROM message WHERE id = 'delivered'`,
  ]) {
    await expect(Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(sql);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "must-rollback" });
    })))).rejects.toMatchObject({ reason: "Sql" });
  }

  expect(await rows(store)).toHaveLength(4);
});

test("message CLI rejects bad usage and uses the selected disposable home when the daemon is down", async () => {
  const home = tempRoot();
  const common = { json: false, home, factory: undefined, env, recipient: "eng.builder", body: "hi", delivery: undefined };
  expect((await runMessageSend({ ...common, delivery: "urgent" })).exitCode).toBe(2);
  expect((await runMessageSend({ ...common, factory: "" })).exitCode).toBe(2);
  expect((await runMessageSend(common)).exitCode).toBe(3);
  const main = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

  const run = (args: Array<string>) => spawnSync(process.execPath, [main, "message", "send", ...args, "--home", home],
    { env: { ...process.env, ...env }, timeout: 20_000 }).status;

  expect(run(["eng.builder"])).toBe(2);
  expect(run(["eng.builder", "hi", "--delivery", "urgent"])).toBe(2);
  expect(run(["eng.builder", "hi"])).toBe(3);
});

// CLI boundary only: disposition business logic is covered by the daemon's real-store tests.
test.each([undefined, [], ["child-id", "grandchild-id"]])("drop confirmation describes descendants (%j) before asking", async (descendants) => {
  const home = tempRoot();

  let message: MessageDispositionResult = { id: "notice", factoryId: "shop", slot: "builder/1",
    kind: "delegation_notice", requestId: null, delegationId: "root-id", ticket: 1, status: "indeterminate",
  };

  if (descendants !== undefined) {message = { ...message, descendantDelegations: descendants };}

  let acted = false;

  const api = await serveManagementApi({ stateRoot: home,
    messageDisposition: {
      inspect: () => Effect.succeed(message),
      act: () => Effect.sync(() => {
        acted = true;

        return { ...message, status: "dropped" as const };
      }),
    },
    status: () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-01-01T00:00:00Z" } }),
  });

  cleanups.push(api.close);
  let notice = "";
  expect(await runMessageDisposition({ id: "notice", action: "drop", yes: false, json: false, home, env,
    terminal: true, notice: (text) => { notice = text; }, confirm: async () => {
      expect(notice).toBe(`Drop message notice (delegation_notice). Request: none; delegation: root-id. A correlated request/delegation will fail.\nOpen descendant delegations to abandon: ${descendants?.join(", ") || "none"}.\n`);
      expect(acted).toBe(false);

      return true;
    },
  })).toMatchObject({ exitCode: 0 });
  expect(acted).toBe(true);
});
