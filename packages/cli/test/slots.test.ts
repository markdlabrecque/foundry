// Integration tier: a real SQLite file with recorded slots and launches behind a real management
// socket, read through the `foundry slot` cores. Launches are recorded by the scheduler with a host
// double; the real host is proved by test/slots.test.ts. Route error codes live in the daemon's
// management-api test; one smoke row runs the built binary to prove the effect/cli wiring.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { createSlotScheduler, openStore, planSlots, serveManagementApi, storeSlotsReader } from "@foundry/daemon";
import type { SlotHost } from "@foundry/daemon";
import type { EffectiveStation } from "@foundry/daemon/config";
import type { LaunchRecord } from "@foundry/host";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE, runSlotList, runSlotShow } from "@foundry/cli";

const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "foundry-slot-cli-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));

  return home;
};

const station = (name: string, instances: number): EffectiveStation => ({
  address: `eng.${name}`,
  room: "eng",
  station: name,
  instructions: [],
  model: "faux/scripted",
  skills: [],
  extensions: [],
  instances,
  isolation: "none",
});

/** Serves alpha's slots (lead/1, dev/1, dev/2) after the scheduler launched lead/1 and dev/1 only. */
const serveSlots = async (): Promise<string> => {
  const home = tempHome();
  const scope = Effect.runSync(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(home, "foundry.db") })));
  const slots = planSlots("alpha", [station("lead", 1), station("dev", 2)]);

  let next = 0;

  const host: SlotHost = {
    inventory: async () => [],
    launch: async (spec): Promise<LaunchRecord> => {
      next += 1;

      if (spec.slotId === "dev/2") {throw new Error("worker host refused launch");}

      return {
        launchId: `launch-${next}`,
        factoryId: spec.factoryId,
        slotId: spec.slotId,
        pid: 4000 + next,
        pgid: 4000 + next,
        bootId: "boot-1",
        startedAt: "2026-02-01T00:00:00.000Z",
        liveness: "live",
      };
    },
  };

  const scheduler = createSlotScheduler({
    store,
    stateRoot: home,
    host,
    hostId: "host-1",
    bootId: "boot-1",
    pi: { command: "/opt/pi/bin/pi", args: [] },
    foundryExtension: "/opt/foundry/extension.js",
    slots,
  });

  await scheduler.schedule();
  await scheduler.recordExit({
    launchId: "launch-1",
    factoryId: "alpha",
    slotId: "lead/1",
    pid: 4001,
    pgid: 4001,
    bootId: "boot-1",
    startedAt: "2026-02-01T00:00:00.000Z",
    liveness: "gone",
    exit: { code: 7, signal: null, endedAt: "2026-02-01T00:05:00.000Z" },
  });

  const status = () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-02-01T00:00:00.000Z" } });
  const api = await serveManagementApi({ stateRoot: home, status, slots: storeSlotsReader(store, home, ["alpha"], slots) });
  cleanups.push(() => api.close());

  return home;
};

test("slot list shows every configured slot with its condition and latest launch", async () => {
  const home = await serveSlots();

  const human = await runSlotList({ json: false, home, factory: undefined, env });
  expect(human).toEqual({
    exitCode: EXIT_OK,
    stdout:
      "alpha  lead/1  eng.lead  normal  launch launch-1 ended (exited)\n" +
      "alpha  dev/1  eng.dev  normal  launch launch-2 live (pid 4002)\n" +
      "alpha  dev/2  eng.dev  normal  no launch\n",
    stderr: "",
  });

  const json = await runSlotList({ json: true, home, factory: "alpha", env });
  expect(json.exitCode).toBe(EXIT_OK);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    result: { slots: [{ slotId: "lead/1" }, { slotId: "dev/1", launch: { launchId: "launch-2", origin: "started", endedAt: null } }, { slotId: "dev/2", launch: null }] },
  });
});

test("slot show prints the launch history with exit reasons; a bad address or unknown slot is refused", async () => {
  const home = await serveSlots();

  expect(await runSlotShow({ json: false, home, factory: undefined, slot: "lead/1", env })).toEqual({
    exitCode: EXIT_OK,
    stdout:
      "slot        lead/1\nfactory     alpha\nstation     eng.lead\ncondition   normal\nlaunches\n" +
      "  launch-1  started  started 2026-02-01T00:00:00.000Z  pid 4001  ended 2026-02-01T00:05:00.000Z (exited, code 7)\n",
    stderr: "",
  });
  expect((await runSlotShow({ json: false, home, factory: undefined, slot: "dev/2", env })).stdout).toContain("launches\n  none\n");
  expect((await runSlotShow({ json: false, home, factory: undefined, slot: "dev-2", env })).exitCode).toBe(EXIT_USAGE);

  const unknown = await runSlotShow({ json: false, home, factory: undefined, slot: "dev/9", env });
  expect(unknown.exitCode).toBe(EXIT_REFUSED);
  expect(unknown.stderr).toContain("No slot dev/9");
});

test("the foundry binary wires slot list through to the daemon check", () => {
  const home = tempHome();

  const result = spawnSync(process.execPath, [cliMain, "slot", "list", "--home", home], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });

  expect(result.status).toBe(EXIT_UNREACHABLE);
});
