// Integration tier: the status core and a real foreground daemon process talking over the
// management socket. This is the one test of the daemon's wiring; socket edge cases live in the
// daemon package. One smoke row runs the built `foundry` binary to prove the effect/cli wiring.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, runStatus } from "@foundry/cli";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");
const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {cleanup();}
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-cli-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  return root;
};

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const run = (args: Array<string>): number | null =>
  spawnSync(process.execPath, [cliMain, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 }).status;


const startDaemon = (home: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, [daemonMain, "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
  // Registered before anything can fail, so no daemon outlives the test.
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();

      if (stdout.includes("management API on")) {resolve(child);}
    });
    child.on("exit", (code) => reject(new Error(`daemon exited ${code} before serving: ${stderr}`)));
  });
};

test("foundry status shows the running daemon's instance, and --json prints the API body", async () => {
  const home = tempRoot();
  const daemon = await startDaemon(home);

  const human = await runStatus({ json: false, home, env });
  expect(human.exitCode).toBe(EXIT_OK);
  expect(human.stdout).toContain(`state root  ${home}`);
  expect(human.stdout).toContain(`daemon pid  ${daemon.pid}`);

  const json = await runStatus({ json: true, home, env });
  expect(json.exitCode).toBe(EXIT_OK);
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, result: { instance: { stateRoot: home, daemonPid: daemon.pid } } });

  const exited = new Promise<number | null>((done) => { daemon.on("exit", done); });
  daemon.kill("SIGTERM");
  expect(await exited).toBe(0);

  // Once stopped, the CLI fails fast as unreachable (PRD §11.5).
  const after = await runStatus({ json: false, home, env });
  expect(after.exitCode).toBe(EXIT_UNREACHABLE);
  expect(after.stderr).toContain("daemon unreachable");
});

test("the foundry binary exits 2 on usage errors and wires status through to the daemon check", () => {
  const home = tempRoot();


  expect(run(["nope"])).toBe(EXIT_USAGE);
  expect(run(["status", "--bogus", "--home", home])).toBe(EXIT_USAGE);
  expect(run(["validate"])).toBe(EXIT_USAGE);
  expect(run(["status", "--home", home])).toBe(EXIT_UNREACHABLE);
});
