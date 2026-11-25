// Integration tier: a real SQLite file with recorded runs and configuration loads behind a real
// management socket, read through the `foundry factory list` core. Proves the list is read from
// daemon state for the served run only, afresh on each request. One smoke row runs the built
// binary to prove the effect/cli wiring; socket edge cases live in the daemon's management-api test.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { openStore, recordRun, serveManagementApi, storeFactoriesReader } from "@foundry/daemon";
import type { RecordedFactory, Store } from "@foundry/daemon";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, runFactoryList } from "@foundry/cli";

const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "foundry-factories-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));

  return home;
};

const openTempStore = async (home: string): Promise<Store> => {
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  return Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(home, "foundry.db") })));
};

/** The fields `recordRun` stores; the rest of a loaded factory is not read by it. */
const factory = (factoryId: string, hash: string): RecordedFactory =>
  ({
    factoryId,
    yamlFile: `/fixture/${factoryId}/factory.yaml`,
    configJson: "{}",
    configHash: `sha256:${hash}`,
    knowledge: { root: `/fixture/${factoryId}/knowledge`, directories: [] },
  });

const record = (store: Store, runId: string, startedAt: number, factories: ReadonlyArray<RecordedFactory>) =>
  Effect.runPromise(recordRun(store, { runId, startedAt, version: "0.0.0", factories }));

test("factory list answers from the served run's recorded configuration loads", async () => {
  const home = tempHome();
  const store = await openTempStore(home);
  // An earlier run loaded a factory this run does not; it must not be listed.
  await record(store, "run-old", Date.parse("2026-01-01T00:00:00.000Z"), [factory("gone", "00")]);

  const loads = await record(store, "run-now", Date.parse("2026-02-01T00:00:00.000Z"), [
    factory("alpha", "aa"),
    factory("beta", "bb"),
  ]);

  const status = () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-02-01T00:00:00.000Z" } });
  const api = await serveManagementApi({ stateRoot: home, status, factories: storeFactoriesReader(store, "run-now") });
  cleanups.push(() => api.close());

  const json = await runFactoryList({ json: true, home, env });
  expect(json.exitCode).toBe(EXIT_OK);
  expect(JSON.parse(json.stdout)).toEqual({
    ok: true,
    result: {
      runId: "run-now",
      loadedAt: "2026-02-01T00:00:00.000Z",
      factories: [
        {
          factoryId: "alpha",
          state: "running",
          loadId: loads[0]!.loadId,
          yamlFile: "/fixture/alpha/factory.yaml",
          configHash: "sha256:aa",
          knowledgeRoot: "/fixture/alpha/knowledge",
        },
        {
          factoryId: "beta",
          state: "running",
          loadId: loads[1]!.loadId,
          yamlFile: "/fixture/beta/factory.yaml",
          configHash: "sha256:bb",
          knowledgeRoot: "/fixture/beta/knowledge",
        },
      ],
    },
  });

  const human = await runFactoryList({ json: false, home, env });
  expect(human.exitCode).toBe(EXIT_OK);
  expect(human.stdout).toBe(
    `alpha  running  load ${loads[0]!.loadId}  sha256:aa  /fixture/alpha/factory.yaml\n` +
      `beta  running  load ${loads[1]!.loadId}  sha256:bb  /fixture/beta/factory.yaml\n`,
  );

  // A change to the stored loads shows on the next request: the answer is read from state, not memory.
  await Effect.runPromise(
    store.change(({ query, recordHistory }) =>
      Effect.gen(function* () {
        yield* query(`DELETE FROM factory_config_load WHERE run_id = 'run-now' AND factory_id = 'beta'`);
        yield* recordHistory({ factoryId: "beta", kind: "probe", subject: "fixture" });
      }),
    ),
  );
  const after = await runFactoryList({ json: false, home, env });
  expect(after.stdout).toBe(`alpha  running  load ${loads[0]!.loadId}  sha256:aa  /fixture/alpha/factory.yaml\n`);
});

test("a served run with no record is refused, not answered with an empty list", async () => {
  const home = tempHome();
  const store = await openTempStore(home);
  const status = () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-02-01T00:00:00.000Z" } });
  const api = await serveManagementApi({ stateRoot: home, status, factories: storeFactoriesReader(store, "missing") });
  cleanups.push(() => api.close());

  const outcome = await runFactoryList({ json: false, home, env });
  expect(outcome.exitCode).toBe(EXIT_REFUSED);
  expect(outcome.stderr).toContain("run missing is not recorded");
});

test("the foundry binary wires factory list through to the daemon check", () => {
  const home = tempHome();

  const result = spawnSync(process.execPath, [cliMain, "factory", "list", "--home", home], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });

  expect(result.status).toBe(EXIT_UNREACHABLE);
});
