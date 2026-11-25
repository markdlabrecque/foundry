// Integration tier: the claim is about which open records a real SQLite store holds and what a
// start writes back, so it runs the start checks against one disposable database file. Spawning
// the daemon would only re-prove the wiring that factory-loads.test.ts already covers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect } from "effect";
import { DATABASE_FILE_NAME, decideFactoryStarts, describeBlocker, openStore, ticketRecord } from "@foundry/daemon";
import type { StartingFactory, Store } from "@foundry/daemon";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foundry-start-refusal-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const withStore = <A, E>(use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename: join(dir, DATABASE_FILE_NAME) }), use)));

type Lines = StartingFactory["config"]["production_lines"];

const line = (...stages: Array<string>): Lines[string] => ({
  stages: stages.map((id) => ({ id, station: "eng.dev", writing: false, approval: false })),
});

const factory = (factoryId: string, lines: Lines, loadId?: number): StartingFactory => {
  const config = {
    production_lines: lines,
    rooms: { eng: { stations: { dev: { instances: 1, isolation: "none" as const } } } },
  };

  return loadId === undefined ? { factoryId, config } : { factoryId, config, loadId };
};

type Position = { state: "backlog" } | { state: "stage"; stage: string; status: string } | { state: "completed" | "cancelled"; stage: string };

/** Puts a ticket straight into a position, with its history row, as later scheduling would. */
const seedTicket = (store: Store, factoryId: string, number: number, productionLine: string, at: Position) =>
  store.change(({ query, recordHistory }) =>
    Effect.gen(function* () {
      // A closed ticket keeps the stage it ended in only in its transitions; the ticket row has none.
      const stage = at.state === "stage" ? at.stage : null;
      const status = at.state === "stage" ? at.status : null;
      yield* query(
        `INSERT INTO ticket (factory_id, number, title, slug, production_line, directory, state, stage, status,
           rejection_ceiling, message_ceiling, submitted_at)
         VALUES (?, ?, 't', 't', ?, '/fixture', ?, ?, ?, 3, 100, 0)`,
        [factoryId, number, productionLine, at.state, stage, status],
      );
      yield* query(
        `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, to_state, to_stage, to_status)
         VALUES (?, ?, 0, 'daemon', ?, ?, ?)`,
        [factoryId, number, at.state, at.state === "backlog" ? null : at.stage, status],
      );
      yield* recordHistory({ factoryId, kind: "ticket.transitioned", subject: String(number), records: [ticketRecord(number)] });
    }),
  );

const refusals = (store: Store) =>
  store.read<{ factory_id: string; subject: string; detail: string }>(
    `SELECT factory_id, subject, detail FROM history WHERE kind = 'factory.start_refused' ORDER BY sequence`,
  );

test("an open ticket at a removed stage refuses its factory alone; closed tickets and the other factory do not block", async () => {
  const result = await withStore((store) =>
    Effect.gen(function* () {
      // shop's "review" stage, and its whole "hotfix" line, are about to be removed from the config.
      yield* seedTicket(store, "shop", 1, "feature", { state: "stage", stage: "review", status: "paused" });
      yield* seedTicket(store, "shop", 2, "feature", { state: "stage", stage: "develop", status: "assigned" });
      // Closed tickets on the removed line: only the state filter keeps them from blocking.
      yield* seedTicket(store, "shop", 3, "hotfix", { state: "completed", stage: "review" });
      yield* seedTicket(store, "shop", 4, "hotfix", { state: "cancelled", stage: "review" });
      yield* seedTicket(store, "shop", 5, "hotfix", { state: "backlog" });
      // blog names the same stage IDs, but its config still has them.
      yield* seedTicket(store, "blog", 1, "feature", { state: "stage", stage: "review", status: "queued" });

      const decision = yield* decideFactoryStarts(store, [
        factory("shop", { feature: line("develop", "integrate") }, 7),
        factory("blog", { feature: line("develop", "review") }, 8),
      ]);

      return { decision, refused: yield* refusals(store) };
    }),
  );

  expect(result.decision.started).toEqual(["blog"]);
  expect(result.decision.refused.map((r) => [r.factoryId, r.blockers.map(describeBlocker)])).toEqual([
    ["shop", ["ticket 1 names stage review of line feature", "ticket 5 names production line hotfix"]],
  ]);
  // One durable row names the blockers and the load they were checked against. Tickets 3 and 4
  // name the removed line too, but are completed and cancelled, so the open-state filter excludes
  // them; transition history is never read.
  expect(result.refused.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([
    {
      factory_id: "shop",
      subject: "shop",
      detail: {
        configLoad: "7",
        blockers: [
          { kind: "ticket", id: "1", missing: { kind: "stage", line: "feature", stage: "review" } },
          { kind: "ticket", id: "5", missing: { kind: "production_line", line: "hotfix" } },
        ],
      },
    },
  ]);
});

/** Seed durable message state without involving delivery, workers or operator state. */
const seedMessage = (store: Store, factoryId: string, id: string, sequence: number, recipient: string, status: string, boundSlot: string | null = null) =>
  store.change(({ query, recordHistory }) => Effect.gen(function* () {
    yield* query(
      `INSERT INTO message (id, factory_id, sequence, sender_slot, recipient, body, delivery, kind,
         status, accepted_at, bound_slot, bound_at)
       VALUES (?, ?, ?, 'removed-sender/1', ?, 'fixture', 'after_turn', 'ordinary', ?, 0, ?, ?)`,
      [id, factoryId, sequence, recipient, status, boundSlot, boundSlot === null ? null : 0],
    );
    yield* recordHistory({ factoryId, kind: "message.accepted", subject: id, records: [{ kind: "message", id }] });
  }));

test("unacknowledged messages name removed recipients and bound slots in a durable per-factory refusal", async () => {
  const result = await withStore((store) => Effect.gen(function* () {
    yield* seedMessage(store, "shop", "unbound", 1, "eng.removed", "unbound");
    // Pool shrank to one; the recipient still exists, but the immutable binding does not.
    yield* seedMessage(store, "shop", "bound", 2, "eng.dev", "bound", "dev/2");
    yield* seedMessage(store, "shop", "sent", 3, "eng.removed", "sent", "removed/1");
    yield* seedMessage(store, "shop", "uncertain", 4, "eng.dev", "indeterminate", "dev/3");
    yield* seedMessage(store, "shop", "valid", 5, "eng.dev", "sent", "dev/1");
    yield* seedMessage(store, "blog", "other", 1, "eng.dev", "bound", "dev/1");

    const decision = yield* decideFactoryStarts(store, [factory("shop", {}, 9), factory("blog", {}, 10)]);

    return { decision, refused: yield* refusals(store) };
  }));

  const blockers = [
    { kind: "message", id: "unbound", missing: { kind: "station", station: "eng.removed" } },
    { kind: "message", id: "bound", missing: { kind: "slot", slot: "dev/2" } },
    { kind: "message", id: "sent", missing: { kind: "station", station: "eng.removed" } },
    { kind: "message", id: "sent", missing: { kind: "slot", slot: "removed/1" } },
    { kind: "message", id: "uncertain", missing: { kind: "slot", slot: "dev/3" } },
  ];

  expect(result.decision.started).toEqual(["blog"]);
  expect(result.decision.refused.map((r) => [r.factoryId, r.blockers.map(describeBlocker)])).toEqual([
    ["shop", [
      "message unbound names station eng.removed",
      "message bound names slot dev/2",
      "message sent names station eng.removed",
      "message sent names slot removed/1",
      "message uncertain names slot dev/3",
    ]],
  ]);
  expect(result.refused.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([
    { factory_id: "shop", subject: "shop", detail: { configLoad: "9", blockers } },
  ]);
});

test("acknowledged and closed messages do not block; current destinations do not depend on removed senders", async () => {
  const result = await withStore((store) => Effect.gen(function* () {
    for (const [index, status] of ["acknowledged", "dropped", "expired"].entries()) {
      yield* seedMessage(store, "shop", status, index + 1, "old.removed", status, "removed/9");
    }

    yield* seedMessage(store, "shop", "waiting", 4, "eng.dev", "unbound");
    yield* seedMessage(store, "shop", "current", 5, "eng.dev", "sent", "dev/1");
    // Identical names in a different factory cannot make this factory refuse.
    yield* seedMessage(store, "elsewhere", "foreign", 1, "old.removed", "sent", "removed/9");
    const decision = yield* decideFactoryStarts(store, [factory("shop", {})]);

    return { decision, refused: yield* refusals(store) };
  }));

  expect(result).toEqual({ decision: { started: ["shop"], refused: [] }, refused: [] });
});

/** Keep notices acknowledged so only the delegation check can account for these references. */
const seedDelegationRoot = (store: Store, factoryId: string) => Effect.gen(function* () {
  yield* seedTicket(store, factoryId, 1, "feature", { state: "stage", stage: "develop", status: "assigned" });
  yield* seedMessage(store, factoryId, `${factoryId}-context`, 1, "eng.dev", "acknowledged", "dev/1");
  yield* store.change(({ query, recordHistory }) => Effect.gen(function* () {
    yield* query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, 'dev/1', 'eng.dev', 1, 'normal')`, [factoryId]);
    yield* query(`INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status, recovery_ceiling, created_at, context_message)
      VALUES (?, ?, 1, 'develop', 'dev/1', 'active', 3, 0, ?)`, [`${factoryId}-root`, factoryId, `${factoryId}-context`]);
    yield* recordHistory({ factoryId, kind: "fixture", subject: "delegation-root" });
  }));
});

const seedDelegation = (store: Store, factoryId: string, id: string, sequence: number, recipient: string,
  recipientSlot: string | null, delegatingSlot = "dev/1", status = "open") => Effect.gen(function* () {
  yield* seedMessage(store, factoryId, `${id}-notice`, sequence, recipient, "acknowledged", recipientSlot);
  yield* store.change(({ query, recordHistory }) => Effect.gen(function* () {
    yield* query(`INSERT INTO delegation (id, factory_id, root_assignment, delegating_slot, recipient, recipient_slot,
      depth, notice_id, status, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [id, factoryId, `${factoryId}-root`, delegatingSlot, recipient, recipientSlot, `${id}-notice`, status, sequence]);
    yield* recordHistory({ factoryId, kind: "delegation.accepted", subject: id, records: [{ kind: "delegation", id }] });
  }));
});

test("open delegations name removed stations and slots in durable refusal evidence independently of their acknowledged notices", async () => {
  const result = await withStore((store) => Effect.gen(function* () {
    yield* seedDelegationRoot(store, "shop");
    yield* seedDelegationRoot(store, "blog");
    yield* seedDelegation(store, "shop", "waiting", 2, "eng.removed", null);
    yield* seedDelegation(store, "shop", "selected", 3, "eng.dev", "dev/2");
    yield* seedDelegation(store, "shop", "returning", 4, "eng.dev", "dev/1", "removed/1");
    yield* seedDelegation(store, "shop", "both", 5, "old.removed", "old/1", "old/1");
    yield* seedDelegation(store, "blog", "other", 2, "eng.dev", "dev/1");

    const decision = yield* decideFactoryStarts(store, [
      factory("shop", { feature: line("develop") }, 11), factory("blog", { feature: line("develop") }, 12),
    ]);

    return { decision, refused: yield* refusals(store) };
  }));

  expect(result.decision.started).toEqual(["blog"]);
  expect(result.decision.refused.map((r) => [r.factoryId, r.blockers.map(describeBlocker)])).toEqual([
    ["shop", [
      "delegation waiting names station eng.removed",
      "delegation selected names slot dev/2",
      "delegation returning names slot removed/1",
      "delegation both names station old.removed",
      "delegation both names slot old/1",
    ]],
  ]);
  expect(result.refused.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([
    { factory_id: "shop", subject: "shop", detail: { configLoad: "11", blockers: [
      { kind: "delegation", id: "waiting", missing: { kind: "station", station: "eng.removed" } },
      { kind: "delegation", id: "selected", missing: { kind: "slot", slot: "dev/2" } },
      { kind: "delegation", id: "returning", missing: { kind: "slot", slot: "removed/1" } },
      { kind: "delegation", id: "both", missing: { kind: "station", station: "old.removed" } },
      { kind: "delegation", id: "both", missing: { kind: "slot", slot: "old/1" } },
    ] } },
  ]);
});

test("resolved delegations and other factories do not block, while valid selected and unselected obligations can start", async () => {
  const result = await withStore((store) => Effect.gen(function* () {
    yield* seedDelegationRoot(store, "shop");
    yield* seedDelegationRoot(store, "elsewhere");

    for (const [index, status] of ["completed", "abandoned", "cancelled"].entries()) {
      yield* seedDelegation(store, "shop", status, index + 2, "old.removed", "old/2", "old/1", status);
    }

    yield* seedDelegation(store, "shop", "waiting", 5, "eng.dev", null);
    yield* seedDelegation(store, "shop", "selected", 6, "eng.dev", "dev/1");
    yield* seedDelegation(store, "elsewhere", "foreign", 2, "old.removed", "old/2", "old/1");
    const decision = yield* decideFactoryStarts(store, [factory("shop", { feature: line("develop") })]);

    return { decision, refused: yield* refusals(store) };
  }));

  expect(result).toEqual({ decision: { started: ["shop"], refused: [] }, refused: [] });
});

test("with no blockers every factory starts and nothing is written", async () => {
  const result = await withStore((store) =>
    Effect.gen(function* () {
      yield* seedTicket(store, "shop", 1, "feature", { state: "stage", stage: "develop", status: "queued" });
      const before = yield* store.read<{ n: number }>(`SELECT count(*) AS n FROM history`);
      const decision = yield* decideFactoryStarts(store, [factory("shop", { feature: line("develop") }), factory("blog", {})]);
      const after = yield* store.read<{ n: number }>(`SELECT count(*) AS n FROM history`);

      return { decision, written: after[0]!.n - before[0]!.n };
    }),
  );

  expect(result.decision).toEqual({ started: ["shop", "blog"], refused: [] });
  expect(result.written).toBe(0);
});
