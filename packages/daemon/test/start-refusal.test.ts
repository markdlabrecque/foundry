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
  const config = { production_lines: lines };

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
