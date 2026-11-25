import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { claimStateRoot, LOCK_FILE_NAME, StateRootLockedError } from "@foundry/daemon";

// The daemon's foreground entry point, from the built package.
const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");

const roots: string[] = [];
const children: ChildProcess[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-lock-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const startDaemon = (home: string) => {
  // FOUNDRY_HOME points elsewhere to prove --home wins and the operator's root is never used.
  const child = spawn(process.execPath, [daemonMain, "--home", home], {
    env: { ...process.env, FOUNDRY_HOME: join(home, "not-this-one") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; stderr: string }>((done) =>
    child.on("exit", (code) => done({ code, stderr })),
  );
  const claimed = new Promise<void>((done, fail) => {
    child.stdout!.on("data", () => stdout.includes("claimed") && done());
    void exited.then(({ code }) => fail(new Error(`daemon exited ${code} before claiming: ${stderr}`)));
  });
  // A refused daemon never claims; callers that do not await `claimed` must not see an unhandled rejection.
  claimed.catch(() => {});
  return { child, claimed, exited };
};

test("a second daemon cannot take the state root while the first owns it", async () => {
  const home = tempRoot();
  const first = startDaemon(home);
  await first.claimed;
  expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(true);

  const second = await startDaemon(home).exited;
  expect(second.code).toBe(1);
  expect(second.stderr).toContain(`pid ${first.child.pid}`);

  first.child.kill("SIGTERM");
  expect((await first.exited).code).toBe(0);
  expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false);

  // Once released, the root can be claimed again.
  const third = startDaemon(home);
  await third.claimed;
  third.child.kill("SIGINT");
  expect((await third.exited).code).toBe(0);
});

test("a lock left by a dead process is reclaimed; one naming no owner is refused", async () => {
  const home = tempRoot();
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((done) => dead.on("exit", done));
  writeFileSync(join(home, LOCK_FILE_NAME), JSON.stringify({ pid: dead.pid, startedAt: "x" }));
  const claim = claimStateRoot(home);
  expect(() => claimStateRoot(home)).toThrow(StateRootLockedError);
  claim.release();
  expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false);

  writeFileSync(join(home, LOCK_FILE_NAME), "garbage");
  expect(() => claimStateRoot(home)).toThrow(StateRootLockedError);
  expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(true);
});
