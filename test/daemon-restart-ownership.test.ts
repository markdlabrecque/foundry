// Tier: integration. The claim is about a real daemon restart against a Worker Host that outlived
// the first daemon (PRD §10.2 step 2), so it runs the built foreground daemon twice against one
// disposable state root, with a stub Pi in place of the pinned Pi. The ownership rules themselves
// are proved by the classifier's unit test; this proves the restart wiring once.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Schema } from "effect";
import { connectHost } from "@foundry/host";
import { SlotListResult } from "@foundry/protocol/slots-api";
import { runHoldList, runSlotList } from "@foundry/cli";
import { isolatedGitEnv, makeGitSource, stopHost, writeStubPi } from "@foundry/testkit";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");

const cleanups: Array<() => Promise<void> | void> = [];
const children: Array<ChildProcess> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}}

  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
};

const FACTORY_YAML = `version: 1
name: alpha
repository:
  source: ./repo
  default_branch: main
default_production_line: f
rooms:
  eng:
    stations:
      dev: { isolation: worktree, model: p/m }
      rev: { isolation: worktree, model: p/m }
production_lines:
  f:
    verify: [npm, test]
    stages:
      - id: a
        station: eng.dev
        writing: true
      - id: b
        station: eng.rev
        approval: true
        on_rejection: a
`;

/** Starts the built daemon, resolves once it serves; `stop` sends SIGTERM and awaits a clean exit. */
const startDaemon = async (home: string, file: string, piBin: string): Promise<{ stop: () => Promise<number | null> }> => {
  const child = spawn(process.execPath, [daemonMain, "--home", home, file], {
    // FOUNDRY_HOME points elsewhere so the operator's root is never used; Git is isolated.
    env: { ...isolatedGitEnv(), FOUNDRY_HOME: join(home, "not-this-one"), FOUNDRY_PI_BIN: piBin },
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((done) => { child.on("exit", (code) => done(code)); });

  await new Promise<void>((done, fail) => {
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();

      if (stdout.includes("management API on")) {done();}
    });
    void exited.then((code) => fail(new Error(`daemon exited ${code}: ${stderr}`)));
  });

  return {
    stop: async () => {
      child.kill("SIGTERM");

      return exited;
    },
  };
};

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const decodeSlotList = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ result: SlotListResult })));

const listSlots = async (home: string) => {
  const listed = await runSlotList({ json: true, home, factory: undefined, env });
  expect(listed.exitCode).toBe(0);

  return decodeSlotList(listed.stdout).result.slots;
};

test("a restarted daemon keeps a proven launch and freezes a slot holding an orphan instead of adopting it", async () => {
  const home = tempDir("foundry-restart-");
  cleanups.push(() => stopHost(home));
  const factoryDir = tempDir("foundry-restart-factory-");
  makeGitSource(join(factoryDir, "repo"));
  const file = join(factoryDir, "factory.yaml");
  writeFileSync(file, FACTORY_YAML);
  const piBin = writeStubPi(tempDir("foundry-restart-pi-"));

  // First run: each slot gets its first launch. Stopping the daemon leaves the host and its launches running.
  const first = await startDaemon(home, file, piBin);
  const before = await listSlots(home);
  expect(before.map((s) => [s.slotId, s.condition])).toEqual([["dev/1", "normal"], ["rev/1", "normal"]]);
  expect(await first.stop()).toBe(0);

  const host = await connectHost(home);
  cleanups.push(() => host.close());
  const devLaunch = before[0]!.launch!.launchId;
  const revLaunch = before[1]!.launch!.launchId;

  // While no daemon runs, rev/1's launch ends and something nobody requested appears in its slot.
  expect((await host.terminate(revLaunch, { graceMs: 0 })).outcome).toBe("gone");
  const orphan = await host.launch({ factoryId: "alpha", slotId: "rev/1", command: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"], cwd: home });

  // Second run, against the surviving host.
  const second = await startDaemon(home, file, piBin);
  const after = await listSlots(home);

  // dev/1's proven launch is kept, not replaced; rev/1 is frozen, its orphan neither adopted nor joined.
  expect(after).toMatchObject([
    { slotId: "dev/1", condition: "normal", launch: { launchId: devLaunch } },
    { slotId: "rev/1", condition: "frozen", freezeCause: "unknown_ownership", launch: { launchId: revLaunch } },
  ]);

  const live = (await host.inventory()).filter((l) => l.liveness === "live").map((l) => l.launchId).sort();
  expect(live).toEqual([devLaunch, orphan.launchId].sort());

  const holds = await runHoldList({ json: true, home, env });
  expect(JSON.parse(holds.stdout)).toMatchObject({
    ok: true,
    result: { holds: [{ kind: "frozen_slot", subject: "rev/1", evidence: { cause: "unknown_ownership", reason: "unrecorded_live_launch", launchId: orphan.launchId } }] },
  });

  expect(await second.stop()).toBe(0);
});
