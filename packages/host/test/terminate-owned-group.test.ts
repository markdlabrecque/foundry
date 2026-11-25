// Integration tier: the claim is that real signals reach exactly one real
// process group, including a non-detached child, while another group lives;
// no in-process double can prove which kernel processes end.
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectHost, launchStderrPath, startHost, type LaunchRecord } from "@foundry/host";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Stub worker that ignores SIGTERM and starts a non-detached child (same
 * process group) that also ignores SIGTERM, then writes the child's pid.
 */
const STUBBORN_WITH_CHILD = `
  const fs = require("node:fs");
  const { spawn } = require("node:child_process");
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.once("spawn", () => fs.writeFileSync("child.pid", String(child.pid)));
  setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("terminating a launch ends its whole group, non-detached child included, while another group lives", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "foundry-host-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  const groups: number[] = [];
  const pids: number[] = [];
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
  let hostPid: number | undefined;
  cleanups.push(async () => {
    if (hostPid !== undefined && isAlive(hostPid)) process.kill(hostPid, "SIGTERM");
  });

  const host = await startHost(stateRoot);
  hostPid = host.pid;
  const control = await connectHost(stateRoot);
  cleanups.push(async () => control.close());

  const targetDir = join(stateRoot, "launches", "slot-1");
  const otherDir = join(stateRoot, "launches", "slot-2");
  await mkdir(targetDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });

  const target = await control.launch({
    factoryId: "factory-a",
    slotId: "slot-1",
    command: process.execPath,
    args: ["-e", STUBBORN_WITH_CHILD],
    cwd: targetDir,
  });
  groups.push(target.pgid);
  const other = await control.launch({
    factoryId: "factory-b",
    slotId: "slot-1",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: otherDir,
  });
  groups.push(other.pgid);

  const childPid = Number(await waitForFile(join(targetDir, "child.pid")));
  pids.push(childPid);
  expect(isAlive(childPid)).toBe(true);

  // A launch the host never started is refused, and nothing is signalled.
  await expect(control.terminate("not-a-launch", { graceMs: 0 })).rejects.toThrow(/not owned by this host/);

  // The host writes any stderr file before it reports the exit, so the report bounds the check below.
  const targetExited = new Promise<LaunchRecord>((resolve) =>
    control.onLaunchExited((l) => {
      if (l.launchId === target.launchId) resolve(l);
    }),
  );

  // Both members ignore SIGTERM, so ending the group takes escalation.
  const termination = await control.terminate(target.launchId, { graceMs: 200, killWaitMs: 5_000 });
  expect(termination).toMatchObject({
    outcome: "gone",
    escalated: true,
    launch: { launchId: target.launchId, liveness: "gone", exit: { signal: "SIGKILL" } },
  });
  expect(isAlive(target.pid)).toBe(false);
  expect(isAlive(childPid)).toBe(false);

  // A requested end is not an unexpected one: no stderr file is retained.
  expect((await targetExited).exit).toMatchObject({ signal: "SIGKILL", requested: true });
  await expect(stat(launchStderrPath(stateRoot, target.launchId))).rejects.toThrow(/ENOENT/);

  // The separate group is untouched.
  expect(isAlive(other.pid)).toBe(true);
  const inventory = await control.inventory();
  expect(inventory.find((l) => l.launchId === other.launchId)?.liveness).toBe("live");
  expect(inventory.find((l) => l.launchId === target.launchId)?.liveness).toBe("gone");

  // Terminating a launch already confirmed gone answers gone again without signalling.
  expect(await control.terminate(target.launchId, { graceMs: 0 })).toMatchObject({ outcome: "gone", escalated: false });
  expect(isAlive(other.pid)).toBe(true);
});
