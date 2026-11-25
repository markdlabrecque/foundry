// Integration tier: a real SQLite file behind a real management socket, read through the
// `foundry hold` cores. Proves one open hold per kind and subject end to end, and that its
// evidence reaches the operator. Socket edge cases live in the daemon's management-api test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { closeHold, openStore, raiseHold, serveManagementApi, storeHoldsReader } from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { EXIT_OK, EXIT_REFUSED, runHoldList, runHoldShow } from "@foundry/cli";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const serveHolds = async (): Promise<{ home: string; store: Store }> => {
  const home = mkdtempSync(join(tmpdir(), "foundry-holds-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(home, "foundry.db") })));
  const status = () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } });
  const api = await serveManagementApi({ stateRoot: home, status, holds: storeHoldsReader(store) });
  cleanups.push(() => api.close());

  return { home, store };
};

const frozen = (evidence: Record<string, unknown>) =>
  ({ factoryId: "f1", kind: "frozen_slot", subject: "impl/1", evidence }) as const;

test("a repeated hold keeps one open record, refreshes its evidence, and shows it with its commands", async () => {
  const { home, store } = await serveHolds();
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

  const first = await run(raiseHold(store, frozen({ cause: "host lost", launchId: "L1" })));
  const again = await run(raiseHold(store, frozen({ cause: "host lost", launchId: "L1" })));
  const refreshed = await run(raiseHold(store, frozen({ cause: "host lost", launchId: "L2" })));
  await run(raiseHold(store, { factoryId: "f1", kind: "parked_slot", subject: "impl/1", evidence: {} }));

  expect([first.outcome, again.outcome, refreshed.outcome]).toEqual(["raised", "unchanged", "refreshed"]);
  expect(again.hold.id).toBe(first.hold.id);
  expect(refreshed.hold.id).toBe(first.hold.id);

  const rows = await run(store.read(`SELECT kind, subject, state FROM operator_hold ORDER BY id`));
  expect(rows).toEqual([
    { kind: "frozen_slot", subject: "impl/1", state: "open" },
    { kind: "parked_slot", subject: "impl/1", state: "open" },
  ]);
  // Each write committed one history row; the unchanged repeat wrote none.
  const history = await run(store.read<{ kind: string }>(`SELECT kind FROM history ORDER BY sequence`));
  expect(history.map((h) => h.kind)).toEqual(["hold.raised", "hold.raised", "hold.raised"]);

  // The store itself refuses a second open hold for the same kind and subject.
  const duplicate = await Effect.runPromiseExit(
    store.change(({ query, recordHistory }) =>
      Effect.gen(function* () {
        yield* recordHistory({ factoryId: "f1", kind: "probe", subject: "impl/1" });
        yield* query(
          `INSERT INTO operator_hold (factory_id, kind, subject, state, evidence, raised_at, updated_at)
           VALUES ('f1', 'frozen_slot', 'impl/1', 'open', '{}', 0, 0)`,
        );
      }),
    ),
  );

  expect(duplicate).toMatchObject(Exit.fail({ reason: "Sql" }));

  const list = await runHoldList({ json: false, home, env });
  expect(list.exitCode).toBe(EXIT_OK);
  expect(list.stdout.trim().split("\n")).toHaveLength(2);
  expect(list.stdout).toContain(`${first.hold.id}  frozen_slot  impl/1`);

  const shown = await runHoldShow({ json: false, home, env, id: String(first.hold.id) });
  expect(shown.exitCode).toBe(EXIT_OK);
  expect(shown.stdout).toContain("launchId: L2");
  expect(shown.stdout).toContain("foundry slot unfreeze impl/1");

  const json = await runHoldShow({ json: true, home, env, id: String(first.hold.id) });
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    result: { hold: { kind: "frozen_slot", state: "open", evidence: { launchId: "L2" } } },
  });

  // A closed hold leaves the list but stays showable; a new raise opens a fresh record.
  await run(closeHold(store, first.hold.id, "resolved"));
  expect((await runHoldList({ json: false, home, env })).stdout).not.toContain("frozen_slot");
  expect((await runHoldShow({ json: false, home, env, id: String(first.hold.id) })).stdout).toContain("state       resolved");
  const reopened = await run(raiseHold(store, frozen({ cause: "host lost" })));
  expect(reopened.hold.id).not.toBe(first.hold.id);

  const missing = await runHoldShow({ json: false, home, env, id: "999" });
  expect(missing.exitCode).toBe(EXIT_REFUSED);
  expect(missing.stderr).toContain("no hold 999");
});
