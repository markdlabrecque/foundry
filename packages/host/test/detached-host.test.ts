// Integration tier: the claim is about a real detached subprocess and a real
// Unix socket, which no in-process double can prove.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectHost, type HostIdentity } from "@foundry/host";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Starts a host from a separate starter process that also dials it, then exits. */
function startHostFromStarterProcess(stateRoot: string): HostIdentity {
  const starter = `
    import { connectHost, startHost } from "@foundry/host";
    const root = process.env.FOUNDRY_TEST_STATE_ROOT;
    const started = await startHost(root);
    const control = await connectHost(root);
    await control.identify();
    control.close();
    process.stdout.write(JSON.stringify(started));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", starter], {
    cwd: repoRoot,
    env: { ...process.env, FOUNDRY_TEST_STATE_ROOT: stateRoot },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as HostIdentity;
}

test("a detached Worker Host survives its starter and control client and can be reached again", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "foundry-host-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));

  const started = startHostFromStarterProcess(stateRoot);
  cleanups.push(async () => {
    try {
      process.kill(started.pid, "SIGTERM");
    } catch {}
  });

  // The starter process has exited and its control connection is closed.
  const first = await connectHost(stateRoot);
  expect(await first.identify()).toEqual(started);
  first.close();

  const second = await connectHost(stateRoot);
  expect(await second.identify()).toEqual(started);
  second.close();
});
