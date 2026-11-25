// Integration tier: the claim is about a real detached subprocess and a real
// Unix socket, which no in-process double can prove.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectHost } from "@foundry/host";
import type { HostIdentity } from "@foundry/host";
import { Schema } from "effect";

const decodeStarted = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      starterPid: Schema.Number,
      started: Schema.Struct({
        hostId: Schema.String,
        pid: Schema.Number,
        startedAt: Schema.String,
        stateRoot: Schema.String,
        controlVersion: Schema.Number,
        bootId: Schema.String,
      }),
    }),
  ),
);

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

/** Stops whatever host answers on `stateRoot`; does nothing if none answers. */
async function stopHostIfRunning(stateRoot: string): Promise<void> {
  try {
    const control = await connectHost(stateRoot, { requestTimeoutMs: 2000 });
    const { pid } = await control.identify();
    control.close();
    process.kill(pid, "SIGTERM");
  } catch {
    // Nothing answers: no host to stop.
  }
}

/** Starts a host from a separate starter process that also dials it, then exits. */
function startHostFromStarterProcess(stateRoot: string): { starterPid: number; started: HostIdentity } {
  const starter = `
    import { connectHost, startHost } from "@foundry/host";
    const root = process.env.FOUNDRY_TEST_STATE_ROOT;
    const started = await startHost(root);
    const control = await connectHost(root);
    await control.identify();
    control.close();
    process.stdout.write(JSON.stringify({ starterPid: process.pid, started }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", starter], {
    cwd: repoRoot,
    env: { ...process.env, FOUNDRY_TEST_STATE_ROOT: stateRoot },
    encoding: "utf8",
    timeout: 20_000,
  });

  expect(result.status, result.stderr).toBe(0);

  return decodeStarted(result.stdout);
}

test("a detached Worker Host survives its starter and control client and can be reached again", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "foundry-host-"));
  // The host stop is registered before the start, so a failed check below still stops the host.
  cleanups.push(
    () => rm(stateRoot, { recursive: true, force: true }),
    () => stopHostIfRunning(stateRoot),
  );

  const { starterPid, started } = startHostFromStarterProcess(stateRoot);
  expect(started.pid).not.toBe(starterPid);

  // The starter process has exited and its control connection is closed.
  const first = await connectHost(stateRoot);
  expect(await first.identify()).toEqual(started);
  first.close();

  const second = await connectHost(stateRoot);
  expect(await second.identify()).toEqual(started);
  second.close();
});
