// Integration tier: the claim is about a real detached host owning a real
// process group across a lost control client, which no in-process double can prove.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LAUNCH_ENV, connectHost, startHost } from "@foundry/host";
import type { LaunchRecord } from "@foundry/host";
import { Schema } from "effect";

const decodeIdentity = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

/**
 * Stub worker: records the identity it was launched with, then exits with
 * code 7 once the test creates its `release` file in the launch folder.
 */
const STUB = `
  const fs = require("node:fs");
  fs.writeFileSync("identity.json", JSON.stringify({
    factoryId: process.env.${LAUNCH_ENV.factoryId},
    slotId: process.env.${LAUNCH_ENV.slotId},
    launchId: process.env.${LAUNCH_ENV.launchId},
  }));
  fs.writeSync(3, JSON.stringify({version: 1, kind: "agent_tool_collision", collisions: [
    {name: "agent_message", sources: ["/foundry.js", "/project.ts"]}
  ]}));
  setInterval(() => { if (fs.existsSync("release")) process.exit(7); }, 20);
`;

function processGroupOf(pid: number): number {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

test("the host owns a launched process group through launch and exit, across a lost control client", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "foundry-host-"));
  const launchDir = join(stateRoot, "launches", "slot-1");
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  const launchedGroups: Array<number> = [];
  // Registered before anything starts, so a failed check still leaves no process behind.
  cleanups.push(async () => {
    for (const pgid of launchedGroups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  const host = await startHost(stateRoot);
  cleanups.push(async () => {
    if (isAlive(host.pid)) {process.kill(host.pid, "SIGTERM");}
  });
  await mkdir(launchDir, { recursive: true });

  const first = await connectHost(stateRoot);

  const launched = await first.launch({
    factoryId: "factory-a",
    slotId: "slot-1",
    command: process.execPath,
    args: ["-e", STUB],
    cwd: launchDir,
    // The host's identity variables must win over anything a caller passes.
    env: { [LAUNCH_ENV.launchId]: "spoof", [LAUNCH_ENV.slotId]: "spoof" },
  });

  launchedGroups.push(launched.pgid);

  expect(launched).toMatchObject({
    factoryId: "factory-a",
    slotId: "slot-1",
    liveness: "live",
    bootId: host.bootId,
  });
  // The launch leads its own process group, separate from the host's.
  expect(processGroupOf(launched.pid)).toBe(launched.pid);
  expect(launched.pgid).toBe(launched.pid);
  expect(processGroupOf(launched.pid)).not.toBe(processGroupOf(host.pid));

  // A second launch into a slot with a live launch is refused.
  await expect(
    first.launch({ factoryId: "factory-a", slotId: "slot-1", command: process.execPath, args: ["-e", ""], cwd: launchDir }),
  ).rejects.toThrow(/already holds a live launch/);

  // The control client is lost: the launch stays live and owned.
  first.close();
  const second = await connectHost(stateRoot);
  expect(await second.inventory()).toEqual([launched]);
  expect(isAlive(launched.pid)).toBe(true);

  // The launch exits on its own; the host reports the exit as its owner.
  const exited = new Promise<LaunchRecord>((resolve) => { second.onLaunchExited(resolve); });
  await writeFile(join(launchDir, "release"), "");
  const reported = await exited;
  expect(reported).toMatchObject({ launchId: launched.launchId, liveness: "gone", exit: { code: 7, signal: null } });
  expect(reported.startupDiagnostic).toEqual({ version: 1, kind: "agent_tool_collision", collisions: [
    { name: "agent_message", sources: ["/foundry.js", "/project.ts"] },
  ] });
  expect(await second.inventory()).toEqual([reported]);
  second.close();

  // The launch learned its identity from the host (written before it could exit).
  const identity = decodeIdentity(await readFile(join(launchDir, "identity.json"), "utf8"));
  expect(identity).toEqual({ factoryId: "factory-a", slotId: "slot-1", launchId: launched.launchId });

  // A client that missed the event learns the same exit from the inventory.
  const third = await connectHost(stateRoot);
  expect(await third.inventory()).toEqual([reported]);

  // The slot is free again once its launch is gone.
  const relaunchDir = join(stateRoot, "launches", "slot-1-again");
  await mkdir(relaunchDir, { recursive: true });

  const relaunched = await third.launch({
    factoryId: "factory-a",
    slotId: "slot-1",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: relaunchDir,
  });

  launchedGroups.push(relaunched.pgid);
  expect(relaunched).toMatchObject({ slotId: "slot-1", liveness: "live" });
  expect(relaunched.launchId).not.toBe(launched.launchId);
  expect(await third.inventory()).toEqual([reported, relaunched]);
  third.close();
});
