// Integration tier (filesystem + process): the claims are about the files a real detached host
// leaves in a state root when real launches end, which no in-process double can prove.
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  LAUNCH_STDERR_KEEP_PER_SLOT,
  connectHost,
  hostLogPath,
  launchStderrPath,
  startHost,
  type HostConnection,
  type LaunchRecord,
  type LaunchSpec,
} from "@foundry/host";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stub worker: writes `out` to stdout and `err` to stderr, then exits with `code`. */
const stub = (out: string, err: string, code: number): string =>
  `process.stdout.write(${JSON.stringify(out)}); process.stderr.write(${JSON.stringify(err)}, () => process.exit(${code}));`;

/** Runs one launch to its end and returns the exit the host reported. */
async function runToExit(control: HostConnection, spec: LaunchSpec, groups: number[]): Promise<LaunchRecord> {
  const launched = await control.launch(spec);
  groups.push(launched.pgid);
  return new Promise<LaunchRecord>((resolve) => {
    control.onLaunchExited((launch) => {
      if (launch.launchId === launched.launchId) resolve(launch);
    });
  });
}

const lines = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("the host logs launches with references and keeps stderr only for unexpected ends, separately per launch", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "foundry-host-logs-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  const groups: number[] = [];
  // Registered before anything starts, so a failed check still leaves no process behind.
  cleanups.push(async () => {
    for (const pgid of groups) {
      try {
        process.kill(-pgid, "SIGKILL");
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

  const spec = (slotId: string, script: string): LaunchSpec => ({
    factoryId: "factory-a",
    slotId,
    command: process.execPath,
    args: ["-e", script],
    cwd: stateRoot,
    env: { FIXTURE_API_KEY: "sk-fixture-secret" },
  });

  // A clean end keeps no stderr file.
  const clean = await runToExit(control, spec("slot-ok", stub("clean-stdout", "clean-stderr", 0)), groups);
  // An unexpected end keeps its stderr, and only its own; stdout is discarded.
  const failed = await runToExit(control, spec("slot-1", stub("fail-stdout", "boom: launch 0 failed\n", 3)), groups);
  const other = await runToExit(control, spec("slot-2", stub("", "slot-2 failed\n", 1)), groups);

  await expect(stat(launchStderrPath(stateRoot, clean.launchId))).rejects.toThrow(/ENOENT/);
  expect(await readFile(launchStderrPath(stateRoot, failed.launchId), "utf8")).toBe("boom: launch 0 failed\n");
  expect(await readFile(launchStderrPath(stateRoot, other.launchId), "utf8")).toBe("slot-2 failed\n");
  expect((await stat(join(stateRoot, "logs", "launches"))).mode & 0o777).toBe(0o700);
  expect((await stat(launchStderrPath(stateRoot, failed.launchId))).mode & 0o777).toBe(0o600);

  // Each slot keeps only its newest few retained stderr files.
  const slot1 = [failed];
  for (let i = 1; i <= LAUNCH_STDERR_KEEP_PER_SLOT; i++) {
    slot1.push(await runToExit(control, spec("slot-1", stub("", `boom: launch ${i} failed\n`, 3)), groups));
  }
  const retained = (await readdir(join(stateRoot, "logs", "launches"))).sort();
  expect(retained).toEqual(
    [...slot1.slice(1), other].map((l) => `${l.launchId}.stderr`).sort(),
  );

  // A launch that cannot start is logged by its error code, never its command path.
  const missing = join(stateRoot, "no-such-worker-binary");
  await expect(control.launch({ ...spec("slot-3", ""), command: missing })).rejects.toThrow(/failed to start/);

  // host.log: JSON lines joined to the launches, with none of the launch output, args or env.
  const hostLog = await readFile(hostLogPath(stateRoot), "utf8");
  const logged = lines(hostLog);
  expect(logged.every((l) => l["hostId"] === host.hostId)).toBe(true);
  expect(logged).toContainEqual(
    expect.objectContaining({ msg: "launch ended", factoryId: "factory-a", slotId: "slot-ok", launchId: clean.launchId }),
  );
  expect(logged).toContainEqual(
    expect.objectContaining({
      level: "warn",
      msg: "launch ended unexpectedly",
      factoryId: "factory-a",
      slotId: "slot-1",
      launchId: failed.launchId,
      detail: { code: 3, signal: null, stderr: launchStderrPath(stateRoot, failed.launchId) },
    }),
  );
  expect(logged).toContainEqual(
    expect.objectContaining({ level: "warn", msg: "launch refused", slotId: "slot-3", detail: { reason: "ENOENT" } }),
  );
  expect(hostLog).not.toMatch(/stdout|clean-stderr|boom|sk-fixture-secret|process\.exit|no-such-worker-binary/);
});
