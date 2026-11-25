// Integration tier: the CLI and a real foreground daemon process talking over the management
// socket. This is the one test of the daemon's wiring; socket edge cases live in the daemon package.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { EXIT_OK, EXIT_UNREACHABLE, runCli } from "@foundry/cli";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-cli-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const cli = async (args: string[]) => {
  let stdout = "";
  let stderr = "";
  // FOUNDRY_HOME is never the operator's root: every call names --home.
  const code = await runCli(args, {
    env: { FOUNDRY_HOME: "/nonexistent-foundry-home" },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
};

const startDaemon = (home: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, [daemonMain, "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
  // Registered before anything can fail, so no daemon outlives the test.
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("management API on")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`daemon exited ${code} before serving: ${stderr}`)));
  });
};

test("foundry status shows the running daemon's instance, and --json prints the API body", async () => {
  const home = tempRoot();
  const daemon = await startDaemon(home);

  const human = await cli(["status", "--home", home]);
  expect(human.code).toBe(EXIT_OK);
  expect(human.stdout).toContain(`state root  ${home}`);
  expect(human.stdout).toContain(`daemon pid  ${daemon.pid}`);

  const json = await cli(["status", "--json", "--home", home]);
  expect(json.code).toBe(EXIT_OK);
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, result: { instance: { stateRoot: home, daemonPid: daemon.pid } } });

  const exited = new Promise<number | null>((done) => daemon.on("exit", done));
  daemon.kill("SIGTERM");
  expect(await exited).toBe(0);

  // Once stopped, the CLI fails fast as unreachable (PRD §11.5).
  const after = await cli(["status", "--home", home]);
  expect(after.code).toBe(EXIT_UNREACHABLE);
  expect(after.stderr).toContain("daemon unreachable");
});
