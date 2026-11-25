// Integration tier: the claim is that a slot is released for reuse only once its launch's whole
// real process group is gone, not merely its leader (PRD §10.3); only real kernel processes show it.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectHost, startHost } from "@foundry/host";
import type { LaunchRecord } from "@foundry/host";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

/** Leader that starts a non-detached child (same process group), records its pid, then exits. */
const LEADER_LEAVES_CHILD = `
  const fs = require("node:fs");
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.once("spawn", () => {
    fs.writeFileSync("child.pid", String(child.pid));
    process.exit(0);
  });
`;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const waitForFile = async (path: string, timeoutMs = 5000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (Date.now() >= deadline) {throw error;}

      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  }
};

test("a slot whose leader exited stays occupied until the rest of its group is gone", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "foundry-host-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  const groups: Array<number> = [];
  const pids: Array<number> = [];
  // Registered before anything starts, so a failed check still leaves no process behind.
  cleanups.push(async () => {
    for (const pgid of groups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  const host = await startHost(stateRoot);
  // Waits for the host to exit: while stopping it still writes under `logs/`, which would race
  // the state root's removal (ENOTEMPTY) and outlive the test.
  cleanups.push(async () => {
    if (!isAlive(host.pid)) {return;}

    process.kill(host.pid, "SIGTERM");
    const deadline = Date.now() + 5000;

    while (isAlive(host.pid)) {
      if (Date.now() >= deadline) {
        process.kill(host.pid, "SIGKILL");
        break;
      }

      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  });
  const control = await connectHost(stateRoot);
  cleanups.push(async () => control.close());

  const dir = join(stateRoot, "launches", "slot-1");
  await mkdir(dir, { recursive: true });
  const exited = new Promise<LaunchRecord>((resolve) => { control.onLaunchExited(resolve); });

  const first = await control.launch({ factoryId: "factory-a", slotId: "slot-1", command: process.execPath, args: ["-e", LEADER_LEAVES_CHILD], cwd: dir });
  groups.push(first.pgid);
  const childPid = Number(await waitForFile(join(dir, "child.pid")));
  pids.push(childPid);

  // The leader is gone, but its child still runs in the group: the slot is not free.
  expect(await exited).toMatchObject({ launchId: first.launchId, liveness: "gone" });
  expect(isAlive(childPid)).toBe(true);

  const again = { factoryId: "factory-a", slotId: "slot-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: dir };
  await expect(control.launch(again)).rejects.toThrow(/already holds a live launch/);

  // Once the group empties, the host frees the slot.
  process.kill(childPid, "SIGKILL");
  let relaunched: LaunchRecord | undefined;

  await expect
    .poll(async () => {
      relaunched ??= await control.launch(again).catch(() => undefined);

      return relaunched?.liveness;
    }, { timeout: 5000 })
    .toBe("live");

  groups.push(relaunched!.pgid);
  expect(relaunched!.launchId).not.toBe(first.launchId);
});
