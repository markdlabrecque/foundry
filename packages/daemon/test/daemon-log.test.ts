// Integration tier (filesystem): the claims are about the files the daemon leaves in a state
// root — format, references, redaction, rotation and permissions — so they need a real directory.
// The process test proves the foreground entry point wires the log in; no cheaper tier can.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { channelLogEvents, daemonLogPath, OMITTED, openDaemonLog, REDACTED } from "@foundry/daemon";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-log-"));
  roots.push(root);
  return root;
};
const lines = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("daemon log lines are JSON with the run ID and references, private, and free of credentials and bodies", () => {
  const root = tempRoot();
  const echoed: string[] = [];
  const log = openDaemonLog({ stateRoot: root, runId: "run-1", stderr: (l) => echoed.push(l) });
  const slotLog = log.with({ factoryId: "f1", slotId: "s1" });
  slotLog.info("message failed", {
    launchId: "l1",
    messageId: "m1",
    ticketId: "t1",
    operationId: "o1",
    detail: { attempt: 2, apiKey: "sk-live-123", authToken: "tok-456", body: "hello worker", text: "prompt text" },
  });
  log.debug("not at info");
  log.close();

  const text = readFileSync(daemonLogPath(root), "utf8");
  expect(text).toBe(echoed.join(""));
  expect(lines(text)).toEqual([
    {
      time: expect.any(String),
      level: "info",
      runId: "run-1",
      msg: "message failed",
      factoryId: "f1",
      slotId: "s1",
      launchId: "l1",
      ticketId: "t1",
      messageId: "m1",
      operationId: "o1",
      detail: { attempt: 2, apiKey: REDACTED, authToken: REDACTED, body: OMITTED, text: OMITTED },
    },
  ]);
  expect(text).not.toMatch(/sk-live-123|tok-456|hello worker|prompt text/);
  expect(statSync(join(root, "logs")).mode & 0o777).toBe(0o700);
  expect(statSync(daemonLogPath(root)).mode & 0o777).toBe(0o600);
});

test("the daemon log rotates by size and keeps a fixed number of files", () => {
  const root = tempRoot();
  const log = openDaemonLog({ stateRoot: root, runId: "r", maxBytes: 200, keepFiles: 3, stderr: () => {} });
  for (let i = 0; i < 20; i++) log.info(`line ${i}`);
  log.close();

  expect(readdirSync(join(root, "logs")).sort()).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2"]);
  for (const name of ["daemon.log", "daemon.log.1", "daemon.log.2"]) {
    const path = join(root, "logs", name);
    expect(statSync(path).size).toBeLessThanOrEqual(200);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  // The newest line is in the live file; the oldest lines were dropped.
  expect(readFileSync(daemonLogPath(root), "utf8")).toContain('"line 19"');
  const kept = ["daemon.log.2", "daemon.log.1", "daemon.log"].map((n) => readFileSync(join(root, "logs", n), "utf8")).join("");
  expect(kept).not.toContain('"line 0"');
});

test("debug adds channel frames by type only, never their contents", () => {
  const root = tempRoot();
  const echoed: string[] = [];
  const atInfo = channelLogEvents(openDaemonLog({ stateRoot: root, runId: "r", stderr: (l) => echoed.push(l) }));
  const slot = { factoryId: "f1", slotId: "s1", launchId: "l1" };
  atInfo.onFrame(slot, { type: "heartbeat" });
  expect(echoed).toEqual([]);

  const atDebug = channelLogEvents(openDaemonLog({ stateRoot: root, runId: "r", level: "debug", stderr: (l) => echoed.push(l) }));
  atDebug.onFrame(slot, { type: "heartbeat" });
  atDebug.onChannelLost(slot, "heartbeat_lapse");
  expect(lines(echoed.join(""))).toEqual([
    expect.objectContaining({ level: "debug", msg: "channel frame", ...slot, detail: { frame: "heartbeat" } }),
    expect.objectContaining({ level: "info", msg: "channel lost", ...slot, detail: { cause: "heartbeat_lapse" } }),
  ]);
});

test("the foreground daemon writes its run to logs/daemon.log and stderr, and nothing to the host log", async () => {
  const home = tempRoot();
  const child = spawn(process.execPath, [daemonMain, "--home", home, "--log-level", "debug"], {
    env: { ...process.env, FOUNDRY_HOME: join(home, "not-this-one") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  await new Promise<void>((done, fail) => {
    child.stdout!.on("data", () => stdout.includes("claimed") && done());
    void exited.then((code) => fail(new Error(`daemon exited ${code}: ${stderr}`)));
  });
  child.kill("SIGTERM");
  expect(await exited).toBe(0);

  const file = readFileSync(daemonLogPath(home), "utf8");
  expect(stderr).toBe(file);
  const logged = lines(file);
  expect(logged.map((l) => l["msg"])).toEqual(["daemon started", "daemon stopping"]);
  const runId = logged[0]!["runId"];
  expect(runId).toEqual(expect.any(String));
  expect(logged.every((l) => l["runId"] === runId)).toBe(true);
  expect(logged[0]).toMatchObject({ level: "info", detail: { logLevel: "debug", pid: child.pid } });
  expect(existsSync(join(home, "logs", "host.log"))).toBe(false);
});
