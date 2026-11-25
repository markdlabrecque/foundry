import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { claimStateRoot, LOCK_FILE_NAME, StateRootLockedError, TAKEOVER_GUARD_FILE_NAME } from "@foundry/daemon";

// The daemon's foreground entry point, from the built package.
const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");

const roots: Array<string> = [];
const children: Array<ChildProcess> = [];

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-lock-"));
  roots.push(root);

  return root;
};

afterEach(() => {
  for (const child of children.splice(0)) {if (child.exitCode === null) {child.kill("SIGKILL");}}

  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });}
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
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const exited = new Promise<{ code: number | null; stderr: string }>((done) =>
    { child.on("exit", (code) => done({ code, stderr })); },
  );

  const claimed = new Promise<void>((done, fail) => {
    child.stdout.on("data", () => stdout.includes("claimed") && done());
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

const deadPid = async (): Promise<number> => {
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((done) => { dead.on("exit", done); });

  return dead.pid!;
};

const ownerFile = (pid: number): string => `${JSON.stringify({ pid, startedAt: "fixture" })}\n`;

const refusal = (claim: () => unknown): StateRootLockedError => {
  try {
    claim();
  } catch (error) {
    if (error instanceof StateRootLockedError) {return error;}

    throw error;
  }

  throw new Error("expected the claim to be refused");
};

test("a lock left by a dead process is reclaimed and then released", async () => {
  const home = tempRoot();
  writeFileSync(join(home, LOCK_FILE_NAME), ownerFile(await deadPid()));
  const claim = claimStateRoot(home);
  expect(refusal(() => claimStateRoot(home)).reason).toBe("held");
  claim.release();
  expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false);
  expect(existsSync(join(home, TAKEOVER_GUARD_FILE_NAME))).toBe(false);
});

test("a lock that names no owner is refused and kept", () => {
  const home = tempRoot();
  writeFileSync(join(home, LOCK_FILE_NAME), "garbage");
  expect(refusal(() => claimStateRoot(home)).reason).toBe("no-owner");
  expect(readFileSync(join(home, LOCK_FILE_NAME), "utf8")).toBe("garbage");
});

test("a lock placed by another owner during a stale takeover survives, and the claim is refused", async () => {
  const home = tempRoot();
  const lockPath = join(home, LOCK_FILE_NAME);
  writeFileSync(lockPath, ownerFile(await deadPid()));
  // A live process other than this one: the test runner's parent.
  const otherOwner = ownerFile(process.ppid);

  const error = refusal(() =>
    claimStateRoot(home, { onStaleLockConfirmed: () => writeFileSync(lockPath, otherOwner) }),
  );

  expect(error.reason).toBe("held");
  expect(error.ownerPid).toBe(process.ppid);
  expect(readFileSync(lockPath, "utf8")).toBe(otherOwner);
  expect(existsSync(join(home, TAKEOVER_GUARD_FILE_NAME))).toBe(false);
});

test("a stale lock is not taken over while a live process holds the takeover guard", async () => {
  const home = tempRoot();
  const stale = ownerFile(await deadPid());
  writeFileSync(join(home, LOCK_FILE_NAME), stale);
  writeFileSync(join(home, TAKEOVER_GUARD_FILE_NAME), ownerFile(process.ppid));
  expect(refusal(() => claimStateRoot(home)).reason).toBe("contended");
  expect(readFileSync(join(home, LOCK_FILE_NAME), "utf8")).toBe(stale);
});

test("a takeover guard left by a dead process is refused with a hint to remove it", async () => {
  const home = tempRoot();
  writeFileSync(join(home, LOCK_FILE_NAME), ownerFile(await deadPid()));
  writeFileSync(join(home, TAKEOVER_GUARD_FILE_NAME), ownerFile(await deadPid()));
  const error = refusal(() => claimStateRoot(home));
  expect(error.reason).toBe("takeover-interrupted");
  expect(error.message).toContain(`remove ${join(home, TAKEOVER_GUARD_FILE_NAME)}`);
});
