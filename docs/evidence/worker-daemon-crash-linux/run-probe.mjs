#!/usr/bin/env node
// Explicit E2E evidence, not a commit-tier test. Real Pi process wiring cannot be proved in-process.
// Reuses the E2E concurrent-worker + faux provider, and FOU-83's isolated environment,
// detached host inventory, debug-channel observations and /proc marker-scoped cleanup approach.
// Linux only. Usage after npm ci && npm run build: node <this file> [output-directory]
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { connectHost } from "@foundry/host";
import { FAUX_PROVIDER_EXTENSION, makeGitSource } from "@foundry/testkit";
import { boundedVerdict, guardedPhases } from "./verdict.mjs";
import { normalizeText, normalizeTree } from "./normalize.mjs";

if (process.platform !== "linux") {throw new Error("Linux /proc cleanup required");}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2] ?? mkdtempSync(join(homedir(), "f124out-")));
mkdirSync(out, { recursive: true });
// A short, private, home-backed root avoids shared /tmp inode exhaustion and long Unix paths.
// Do not trust an outer TMPDIR: each launch receives this exact directory in its allowlist.
const root = mkdtempSync(join(homedir(), "f124-"));
const privateTmp = join(root, "t");
const home = join(root, "home");
const user = join(root, "user");
const marker = join(root, "probe");
const agent = join(root, "agent");
for (const dir of [user, marker, agent, privateTmp]) {mkdirSync(dir, { recursive: true });}
writeFileSync(join(agent, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
const env = {
  PATH: process.env.PATH ?? "", HOME: user, TMPDIR: privateTmp,
  XDG_CONFIG_HOME: join(user, ".config"), XDG_DATA_HOME: join(user, ".local/share"), XDG_CACHE_HOME: join(user, ".cache"),
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PROBE_DIR: marker,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Foundry Fixture", GIT_AUTHOR_EMAIL: "fixture@foundry.invalid",
  GIT_COMMITTER_NAME: "Foundry Fixture", GIT_COMMITTER_EMAIL: "fixture@foundry.invalid",
  FOUNDRY_HOME: join(root, "unused"),
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const events = [];
const checks = {};
let journeyCompleted = false;
let activeDaemon;
writeFileSync(join(out, "NORMALIZATION.md"), "Normalized evidence, not byte-for-byte raw output. Unrelated inherited PATH is redacted. Real user-home and T3 checkout prefixes are consistently replaced by <USER_HOME> and <CHECKOUT>. Versions, executable suffixes, ordered arguments, IDs, times and fixture-relative relationships are preserved. Binary DB/WAL copies are local-only.\n");
const note = (event, detail) => {
  const entry = JSON.parse(normalizeText(JSON.stringify({ at: new Date().toISOString(), event, detail })));
  events.push(entry);
  console.log(JSON.stringify(entry));
};
const until = async (label, predicate, timeout = 30_000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) {return;}
    await sleep(200);
  }
  throw new Error(`${label}: not observed within ${timeout}ms`);
};
const marked = (pid) => {
  try {return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`PROBE_DIR=${marker}`);}
  catch {return false;}
};
const processes = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map(Number).filter(marked);
const kill = (pid) => {
  if (!marked(pid)) {throw new Error(`refusing unmarked PID ${pid}`);}
  process.kill(pid, "SIGKILL");
};
const run = async (file, args, timeout = 30_000) => {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  const exit = await new Promise((done) => child.once("close", (code, signal) => done({ code, signal })));
  clearTimeout(timer);
  const result = { args, ...exit, stdout, stderr };
  note("command", result);
  if (exit.code !== 0) {throw new Error(`command failed: ${JSON.stringify(result)}`);}
  return JSON.parse(stdout).result;
};
const cli = (...args) => run(join(repo, "packages/cli/dist/main.js"), [...args, "--home", home, "--json"]);
const factory = join(root, "factory.yaml");
const driver = join(repo, "docs/evidence/worker-daemon-crash-linux/worker.ts");
const yaml = `version: 1
name: alpha
repository:
  source: ./repo
  default_branch: main
default_production_line: f
worktrees:
  root: ${JSON.stringify(join(root, "worktrees"))}
rooms:
  eng:
    stations:
      dev:
        instances: 2
        isolation: worktree
        model: foundry-faux/scripted
        extensions: [${JSON.stringify(FAUX_PROVIDER_EXTENSION)}, { path: ${JSON.stringify(driver)}, tools: [fixture_work] }]
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: a
        station: eng.dev
        writing: true
      - id: b
        station: eng.dev
        approval: true
        on_rejection: a
`;
writeFileSync(factory, yaml);
writeFileSync(join(out, "factory.yaml"), yaml);
const workerEvents = () => existsSync(join(marker, "worker.jsonl"))
  ? readFileSync(join(marker, "worker.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const logs = () => existsSync(join(home, "logs/daemon.log"))
  ? readFileSync(join(home, "logs/daemon.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const startDaemon = async () => {
  const args = [join(repo, "packages/daemon/dist/main.js"), "--home", home, "--log-level", "debug", factory];
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  activeDaemon = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.finished = new Promise((done) => child.once("close", (code, signal) => done({ code, signal })));
  await until("daemon serving", () => {
    if (child.exitCode !== null || child.signalCode !== null) {throw new Error(`daemon exited: ${stderr}`);}
    return stdout.includes("management API on");
  });
  note("daemon serving", { pid: child.pid, args, stderr });
  return child;
};
const stopDaemon = async () => {
  if (!activeDaemon || activeDaemon.exitCode !== null || activeDaemon.signalCode !== null) {return;}
  kill(activeDaemon.pid);
  note("daemon SIGKILL", await activeDaemon.finished);
};
const processTmpdir = (pid) => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((entry) => entry.startsWith("TMPDIR="))?.slice(7);
const inventory = async () => {
  const host = await connectHost(home);
  try {return { identity: await host.identify(), launches: await host.inventory() };}
  finally {host.close();}
};
const artifact = (ticket) => ({
  number: ticket.number, directory: ticket.directory, specPath: ticket.specPath, evidencePath: ticket.evidencePath,
  worktree: ticket.worktree,
  specHash: createHash("sha256").update(readFileSync(ticket.specPath)).digest("hex"),
  started: readFileSync(join(ticket.worktree.path, "started.txt"), "utf8"),
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ticket.worktree.path, env, encoding: "utf8" }).trim(),
});
// Read only a *copy* of DB+WAL after the daemon has exited, never another connection to its live DB.
const snapshot = (label) => {
  const dir = join(out, label);
  mkdirSync(dir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(home, `foundry.db${suffix}`);
    if (existsSync(path)) {cpSync(path, join(dir, `foundry.db${suffix}`));}
  }
  const db = new DatabaseSync(join(dir, "foundry.db"), { readOnly: true });
  const tables = {};
  try {
    for (const table of ["ticket", "assignment", "assignment_resume", "message", "message_attempt", "launch", "slot", "history"]) {
      tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
    }
  } finally {db.close();}
  writeFileSync(join(dir, "records.json"), `${JSON.stringify(tables, null, 2)}\n`);
  return tables;
};
try {
  makeGitSource(join(root, "repo"));
  note("versions", {
    node: process.version, platform: `${process.platform} ${process.arch}`,
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
    pi: execFileSync(process.execPath, [join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--version"], { env, encoding: "utf8" }).trim(),
    foundry: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    fixture: { driver, faux: FAUX_PROVIDER_EXTENSION, yaml, env: { ...env, PATH: "<REDACTED inherited PATH>" } },
    evidenceSourceSha256: Object.fromEntries(["run-probe.mjs", "worker.ts", "verdict.mjs", "normalize.mjs"].map((file) =>
      [file, createHash("sha256").update(readFileSync(join(repo, "docs/evidence/worker-daemon-crash-linux", file))).digest("hex")])),
    productionBase: execFileSync("git", ["rev-parse", "origin/develop"], { cwd: repo, encoding: "utf8" }).trim(),
  });
  await startDaemon();
  for (const n of [1, 2]) {
    const file = join(root, `spec-${n}.md`);
    writeFileSync(file, `# Crash durability ${n}\nDisposable active tracked work.\n`);
    await cli("ticket", "submit", file);
  }
  let tickets;
  await until("two assigned tickets in actual Pi held tools", async () => {
    tickets = await Promise.all([1, 2].map(async (n) => (await cli("ticket", "show", String(n))).ticket));
    return tickets.every((t) => t.status === "assigned" && existsSync(join(t.evidencePath, "started.txt")));
  });
  const artifactsBefore = tickets.map(artifact);
  const before = await inventory();
  const victim = before.launches.find((l) => l.slotId === "dev/1" && l.liveness === "live");
  if (!victim) {throw new Error("no live dev/1 worker");}
  const tempPropagation = [activeDaemon.pid, before.identity.pid, ...before.launches.filter((l) => l.liveness === "live").map((l) => l.pid)]
    .map((pid) => ({ pid, tmpdir: processTmpdir(pid) }));
  checks.privateTempPropagated = tempPropagation.length === 4 && tempPropagation.every((p) => p.tmpdir === privateTmp) &&
    workerEvents().filter((e) => e.event === "launcher").length === 2 &&
    workerEvents().filter((e) => e.event === "launcher").every((e) => e.detail.tmpdir === privateTmp && e.detail.effectiveTmpdir === privateTmp);
  note("private temp propagation", { privateTmp, tempPropagation, verified: checks.privateTempPropagated });
  if (!checks.privateTempPropagated) {throw new Error("private TMPDIR was not retained by daemon -> host -> Pi workers");}
  note("active before worker kill", { before, artifactsBefore });
  // Accept ordinary work while the original workers are held. A replacement may become idle
  // and acknowledge it before the daemon crash; inspect actual stored status/binding below.
  const accepted = await cli("message", "send", "eng.dev", "FOU124_ACCEPTED_BEFORE_WORKER_KILL", "--delivery", "when_idle");
  note("accepted work", accepted);
  const offsetWorker = logs().length;
  kill(victim.pid);
  note("worker SIGKILL", { pid: victim.pid, launchId: victim.launchId });
  let recovered;
  await until("replacement worker channel accepted", async () => {
    recovered = await inventory();
    return recovered.launches.some((l) => l.slotId === victim.slotId && l.launchId !== victim.launchId && l.liveness === "live" &&
      logs().slice(offsetWorker).some((line) => line.launchId === l.launchId && line.msg === "channel accepted"));
  }, 45_000);
  checks.workerReplacementAccepted = true;
  // Allow actual recovery prime / resume traffic before the daemon crash, not just host startup.
  await until("replacement worker active in held tool", () => recovered.launches.some((l) =>
    l.slotId === victim.slotId && l.launchId !== victim.launchId && workerEvents().some((event) =>
      event.pid === l.pid && event.event === "tool_call" && event.detail.toolName === "fixture_work")));
  note("worker recovery", { recovered, tickets: await Promise.all([1, 2].map((n) => cli("ticket", "show", String(n)))) });
  const preCrash = await inventory();
  const live = preCrash.launches.filter((l) => l.liveness === "live");
  checks.privateTempPropagated = checks.privateTempPropagated && live.every((l) => processTmpdir(l.pid) === privateTmp);
  note("replacement temp propagation", { workers: live.map((l) => ({ pid: l.pid, tmpdir: processTmpdir(l.pid) })), verified: checks.privateTempPropagated });
  await stopDaemon();
  const beforeRestart = snapshot("before-restart");
  checks.acceptedMessageStoredAndBound = beforeRestart.message.some((m) => m.body === "FOU124_ACCEPTED_BEFORE_WORKER_KILL" && m.bound_slot !== null);
  note("before restart", { preCrash, acceptedRows: beforeRestart.message.filter((m) => m.body === "FOU124_ACCEPTED_BEFORE_WORKER_KILL") });
  const offsetRestart = logs().length;
  await startDaemon();
  // Same bounded window as FOU-83: three 15-second channel-loss windows.
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    if (live.every((l) => logs().slice(offsetRestart).some((line) => line.launchId === l.launchId && line.msg === "channel accepted"))) {break;}
    await sleep(500);
  }
  const restartLines = logs().slice(offsetRestart);
  checks.survivingWorkersReconnected = live.length === 2 && live.every((l) => restartLines.some((line) => line.launchId === l.launchId && line.msg === "channel accepted"));
  checks.channelTrafficResumed = live.length === 2 && live.every((l) => restartLines.some((line) => line.launchId === l.launchId && line.msg === "channel frame"));
  const after = await inventory();
  const afterTickets = await Promise.all([1, 2].map(async (n) => (await cli("ticket", "show", String(n))).ticket));
  checks.ticketArtifactsUnchanged = JSON.stringify(artifactsBefore) === JSON.stringify(afterTickets.map(artifact));
  checks.liveLaunchesPreserved = live.length === 2 && live.every((l) => after.launches.some((a) => a.launchId === l.launchId && a.pid === l.pid && a.liveness === "live"));
  note("after restart", { observedMs: Date.now() - started, after, tickets: afterTickets, artifacts: afterTickets.map(artifact), restartLines });
  await stopDaemon();
  const afterRestart = snapshot("after-restart");
  checks.acceptedRowsAndBindingPreserved = beforeRestart.message.every((m) => afterRestart.message.some((a) => a.id === m.id && a.body === m.body && a.bound_slot === m.bound_slot));
  checks.assignmentsPreserved = beforeRestart.assignment.every((a) => afterRestart.assignment.some((b) => b.id === a.id && b.ticket_number === a.ticket_number && b.slot_id === a.slot_id && b.status === a.status));
  journeyCompleted = true;
} catch (error) {
  note("first failure", { stack: String(error.stack ?? error) });
} finally {
  let survivors;
  const cleanupErrors = await guardedPhases([
    ["daemon stop", stopDaemon],
    ["marker sweep", async () => {
      for (let round = 0; round < 50 && processes().length; round++) {
        for (const pid of processes()) {try {kill(pid);} catch (error) {if (error.code !== "ESRCH") {note("sweep retry", String(error));}}}
        await sleep(100);
      }
      survivors = processes();
      checks.cleanup = survivors.length === 0;
      note("marker sweep", { survivors });
    }],
    ["worker evidence", () => {if (existsSync(marker)) {cpSync(marker, join(out, "worker-events"), { recursive: true });}}],
    ["ticket evidence", () => {if (existsSync(join(home, "tickets"))) {cpSync(join(home, "tickets"), join(out, "tickets"), { recursive: true });}}],
    ["process logs", () => {if (existsSync(join(home, "logs"))) {cpSync(join(home, "logs"), join(out, "logs"), { recursive: true });}}],
    ["failure snapshot", () => {
      if (activeDaemon && activeDaemon.exitCode === null && activeDaemon.signalCode === null) {throw new Error("daemon not confirmed exited; refusing database snapshot");}
      if (existsSync(join(home, "foundry.db")) && !existsSync(join(out, "after-restart"))) {snapshot("at-failure");}
    }],
    ["private root removal", () => {
      if (!checks.cleanup) {throw new Error("preserving private root because marked processes remain or sweep failed");}
      rmSync(root, { recursive: true, force: true });
      note("cleanup", { survivors, rootRemoved: !existsSync(root) });
    }],
    ["normalize evidence copies", () => normalizeTree(out)],
  ], (failure) => note("cleanup phase failure", failure));
  checks.cleanupPhasesSucceeded = cleanupErrors.length === 0;
  const verdict = boundedVerdict(checks, journeyCompleted);
  // Final manifest is independent of stop/sweep/copy/removal failures above.
  writeFileSync(join(out, "result.json"), normalizeText(`${JSON.stringify({ ...verdict, journeyCompleted, checks, cleanupErrors, events }, null, 2)}\n`));
  console.log(normalizeText(JSON.stringify({ ...verdict, checks, out })));
  process.exitCode = verdict.exitCode;
}
