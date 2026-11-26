#!/usr/bin/env node
// Explicit E2E evidence, not a commit-tier test. Real Pi process wiring cannot be proved in-process.
// Reuses the historical combined-crash harness patterns, normalization and guarded cleanup.
// Adds actual committed Git effects and tracked continuation, not just surviving channel traffic.
// Linux only. Usage after npm ci && npm run build: node <this file> [output-directory]
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { connectHost } from "@foundry/host";
import { makeGitSource } from "@foundry/testkit";
import { guardedPhases } from "../worker-daemon-crash-linux/verdict.mjs";
import { normalizeText, normalizeTree } from "../worker-daemon-crash-linux/normalize.mjs";
import { continuationChecks, sameUid, verdict } from "./verify.mjs";

if (process.platform !== "linux") {throw new Error("Linux /proc cleanup required");}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2] ?? mkdtempSync(join(homedir(), "f124ao-")));
mkdirSync(out, { recursive: true });
// A short, private, home-backed root avoids shared /tmp inode exhaustion and long Unix paths.
// Do not trust an outer TMPDIR: each launch receives this exact directory in its allowlist.
const root = mkdtempSync(join(homedir(), "f124a-"));
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
  FOUNDRY_HOME: join(root, "unused"), FOUNDRY_WORKER_RUNTIME: "rpc",
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const events = [];
const checks = {};
let journeyCompleted = false;
let activeDaemon;
let shutdownSucceeded = false;
let recordedGroups = [];
let finalEvidence;
const productBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
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
const driver = join(repo, "docs/evidence/worker-daemon-crash-postmerge/worker.mjs");
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
        model: crash-124/scripted
        extensions: [{ path: ${JSON.stringify(driver)}, tools: [fixture_work] }]
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: implement
        station: eng.dev
        writing: true
      - id: gate
        station: eng.dev
        approval: true
        on_rejection: implement
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
const git = (cwd, args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8" }).trim();
const artifact = (ticket) => ({
  number: ticket.number, directory: ticket.directory, specPath: ticket.specPath, evidencePath: ticket.evidencePath,
  worktree: ticket.worktree, specHash: createHash("sha256").update(readFileSync(ticket.specPath)).digest("hex"),
  body: readFileSync(join(ticket.worktree.path, `effect-${ticket.number}.txt`), "utf8"), head: git(ticket.worktree.path, ["rev-parse", "HEAD"]),
});
const groupMembers = (pgid) => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).flatMap((p) => {
  try {
    const fields = readFileSync(`/proc/${p}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
    return Number(fields[2]) === pgid && fields[0] !== "Z" ? [Number(p)] : [];
  } catch {return [];}
});
const killOwnedGroup = (pgid) => {
  const members = groupMembers(pgid);
  if (!members.length) {return;}
  if (!members.every((pid) => marked(pid) && sameUid(readFileSync(`/proc/${pid}/status`, "utf8"), process.getuid()))) {throw new Error(`refusing group ${pgid}: ownership marker/uid mismatch`);}
  process.kill(-pgid, "SIGKILL");
};
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
    for (const table of ["ticket", "ticket_transition", "assignment", "assignment_resume", "message", "message_attempt", "launch", "slot", "history", "submission", "approval"]) {
      tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
    }
  } finally {db.close();}
  writeFileSync(join(dir, "records.json"), `${JSON.stringify(tables, null, 2)}\n`);
  return tables;
};
try {
  const sourceBase = makeGitSource(join(root, "repo"));
  note("versions", {
    node: process.version, platform: `${process.platform} ${process.arch}`,
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
    pi: execFileSync(process.execPath, [join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--version"], { env, encoding: "utf8" }).trim(),
    productionBase: productBase, sourceBase, fixture: { driver, yaml, env: { ...env, PATH: "<REDACTED inherited PATH>" }, FOUNDRY_PI_BIN: "UNSET; no shim" },
    evidenceSourceSha256: Object.fromEntries(["worker-daemon-crash-postmerge/run-probe.mjs", "worker-daemon-crash-postmerge/worker.mjs", "worker-daemon-crash-postmerge/verify.mjs", "worker-daemon-crash-postmerge/history.mjs", "worker-daemon-crash-linux/verdict.mjs", "worker-daemon-crash-linux/normalize.mjs"].map((file) =>
      [file, createHash("sha256").update(readFileSync(join(repo, "docs/evidence", file))).digest("hex")])),
  });
  await startDaemon();
  for (const n of [1, 2]) {
    const file = join(root, `spec-${n}.md`);
    writeFileSync(file, `# Crash durability ${n}\nMake one committed effect, inspect on recovery, then continue the tracked outcome.\n`);
    await cli("ticket", "submit", file);
  }
  let tickets;
  await until("two assigned actual committed effects held in Pi tools", async () => {
    tickets = await Promise.all([1, 2].map(async (n) => (await cli("ticket", "show", String(n))).ticket));
    return tickets.every((t) => t.status === "assigned" && workerEvents().some((e) => e.kind === "held" && e.ticket === t.number));
  });
  const artifactsBefore = tickets.map(artifact);
  const first = await inventory();
  recordedGroups = first.launches.map((l) => l.pgid);
  checks.freshProtocol5Host = first.identity.controlVersion === 5 && first.identity.stateRoot === home;
  checks.originalWorkActive = first.launches.length === 2 && first.launches.every((l) => l.liveness === "live" && workerEvents().some((e) => e.kind === "held" && e.pid === l.pid));
  const tempPropagation = [activeDaemon.pid, first.identity.pid, ...first.launches.map((l) => l.pid)].map((pid) => ({ pid, tmpdir: processTmpdir(pid) }));
  checks.privateTempPropagated = tempPropagation.length === 4 && tempPropagation.every((p) => p.tmpdir === privateTmp) && workerEvents().filter((e) => e.kind === "launcher").every((e) => e.tmpdir === privateTmp && e.effectiveTmpdir === privateTmp);
  note("before worker kill", { first, tempPropagation, artifactsBefore, checks });
  if (!checks.freshProtocol5Host || !checks.privateTempPropagated || !checks.originalWorkActive) {throw new Error("fixture host/temp/active-work shape not established");}
  await cli("message", "send", "eng.dev", "FOU124_BEFORE_WORKER", "--delivery", "when_idle");
  const victim = first.launches.find((l) => l.slotId === "dev/1");
  const offsetWorker = logs().length;
  killOwnedGroup(victim.pgid);
  note("worker group SIGKILL", victim);
  let recovered;
  await until("replacement inspects prior commit and holds the same assignment", async () => {
    recovered = await inventory();
    return recovered.launches.some((l) => l.slotId === victim.slotId && l.launchId !== victim.launchId && l.liveness === "live" && logs().slice(offsetWorker).some((line) => line.launchId === l.launchId && line.msg === "channel accepted") && workerEvents().some((e) => e.kind === "held" && e.pid === l.pid && e.mode === "resume"));
  }, 45_000);
  checks.workerReplacementRecovered = true;
  const preCrash = await inventory();
  recordedGroups = [...new Set(preCrash.launches.map((l) => l.pgid))];
  const live = preCrash.launches.filter((l) => l.liveness === "live");
  checks.privateTempPropagated = checks.privateTempPropagated && live.every((l) => processTmpdir(l.pid) === privateTmp);
  await cli("message", "send", "eng.dev", "FOU124_BEFORE_DAEMON", "--delivery", "when_idle");
  const workCallsBeforeRestart = workerEvents().filter((e) => e.kind === "work-call").length;
  const continuedBeforeRestart = workerEvents().filter((e) => e.kind === "continued").length;
  if (continuedBeforeRestart !== 0 || workCallsBeforeRestart !== 3) {throw new Error("work was not held, or unexpected pre-crash replay occurred");}
  await stopDaemon();
  const beforeRestart = snapshot("before-restart");
  note("before daemon restart", { preCrash, workCallsBeforeRestart, continuedBeforeRestart, acceptedRows: beforeRestart.message });
  const offsetRestart = logs().length;
  await startDaemon();
  const restartedAt = Date.now();
  await until("both surviving original launches reconnect and send heartbeats", () => live.length === 2 && live.every((l) => {
    const lines = logs().slice(offsetRestart).filter((line) => line.launchId === l.launchId);
    return lines.some((line) => line.msg === "channel accepted") && lines.some((line) => line.msg === "channel frame" && line.detail?.frame === "heartbeat");
  }), 45_000);
  checks.survivingWorkersReconnected = true;
  checks.channelTrafficResumed = true;
  const after = await inventory();
  checks.sameHostAndSurvivingLaunches = after.identity.hostId === first.identity.hostId && after.identity.pid === first.identity.pid && after.identity.controlVersion === 5 &&
    after.launches.length === preCrash.launches.length && live.every((l) => after.launches.some((a) => a.launchId === l.launchId && a.pid === l.pid && a.slotId === l.slotId && a.liveness === "live"));
  checks.noDaemonRestartWorkReplay = workCallsBeforeRestart === workerEvents().filter((e) => e.kind === "work-call").length && workerEvents().filter((e) => e.kind === "continued").length === 0;
  note("surviving workers reconnected while still active", { observedMs: Date.now() - restartedAt, after, checks, channelLines: logs().slice(offsetRestart) });
  if (!checks.sameHostAndSurvivingLaunches || !checks.noDaemonRestartWorkReplay) {throw new Error("identity changed or held work was replayed after daemon restart");}
  const releasedAt = new Date().toISOString();
  for (const n of [1, 2]) {writeFileSync(join(marker, `release-${n}`), releasedAt);}
  note("release actual active tools", { releasedAt });
  let finalTickets;
  await until("both tracked tickets continue to operator approval", async () => {
    finalTickets = await Promise.all([1, 2].map(async (n) => (await cli("ticket", "show", String(n))).ticket));
    return finalTickets.every((t) => t.stage === "gate" && t.status === "awaiting_approval") && ["FOU124_BEFORE_WORKER", "FOU124_BEFORE_DAEMON"].every((body) => workerEvents().some((e) => e.kind === "incoming" && e.text?.includes(body)));
  }, 45_000);
  const gitObservations = finalTickets.map((t) => ({ number: t.number, base: t.worktree.startCommit, head: git(t.worktree.path, ["rev-parse", "HEAD"]), commits: git(t.worktree.path, ["rev-list", `${t.worktree.startCommit}..HEAD`]).split("\n").filter(Boolean), body: readFileSync(join(t.worktree.path, `effect-${t.number}.txt`), "utf8"), log: git(t.worktree.path, ["log", "--format=fuller", `${t.worktree.startCommit}..HEAD`]), diff: git(t.worktree.path, ["diff", t.worktree.startCommit, "HEAD"]) }));
  finalEvidence = { artifactsBefore, artifactsAfter: finalTickets.map(artifact), git: gitObservations, releasedAt, liveLaunchIds: live.map((l) => l.launchId), finalTickets };
  note("actual tracked continuation and committed effects", finalEvidence);
  await cli("shutdown");
  const exit = await activeDaemon.finished;
  shutdownSucceeded = exit.code === 0;
  note("fresh host orderly shutdown", { exit, shutdownSucceeded });
  const afterContinuation = snapshot("after-continuation");
  const proof = { before: beforeRestart, after: afterContinuation, workerEvents: workerEvents(), ...finalEvidence };
  Object.assign(checks, continuationChecks(proof));
  writeFileSync(join(out, "continuation-evidence.json"), JSON.stringify(proof, null, 2) + "\n");
  journeyCompleted = true;
} catch (error) {
  note("first failure", { stack: String(error.stack ?? error) });
} finally {
  let survivors;
  const cleanupErrors = await guardedPhases([
    ["pre-fallback cleanup observations", () => {
      const markedPids = processes();
      const groups = recordedGroups.map((pgid) => ({ pgid, liveMembers: groupMembers(pgid) }));
      checks.orderlyCleanup = shutdownSucceeded && markedPids.length === 0 && groups.every((g) => g.liveMembers.length === 0);
      note("pre-fallback cleanup", { shutdownSucceeded, markedPids, groups, orderly: checks.orderlyCleanup });
    }],
    ["daemon stop", stopDaemon],
    ["marker sweep", async () => {
      for (let round = 0; round < 50 && (processes().length || recordedGroups.some((pgid) => groupMembers(pgid).length)); round++) {
        for (const pgid of recordedGroups) {killOwnedGroup(pgid);}
        for (const pid of processes()) {try {kill(pid);} catch (error) {if (error.code !== "ESRCH") {note("sweep retry", String(error));}}}
        await sleep(100);
      }
      survivors = processes();
      const groups = recordedGroups.map((pgid) => ({ pgid, liveMembers: groupMembers(pgid) }));
      checks.cleanup = survivors.length === 0 && groups.every((g) => g.liveMembers.length === 0);
      note("marker sweep", { survivors, groups });
    }],
    ["worker evidence", () => {if (existsSync(marker)) {cpSync(marker, join(out, "worker-events"), { recursive: true });}}],
    ["ticket evidence", () => {if (existsSync(join(home, "tickets"))) {cpSync(join(home, "tickets"), join(out, "tickets"), { recursive: true });}}],
    ["process logs", () => {if (existsSync(join(home, "logs"))) {cpSync(join(home, "logs"), join(out, "logs"), { recursive: true });}}],
    ["failure snapshot", () => {
      if (activeDaemon && activeDaemon.exitCode === null && activeDaemon.signalCode === null) {throw new Error("daemon not confirmed exited; refusing database snapshot");}
      if (existsSync(join(home, "foundry.db")) && !existsSync(join(out, "after-continuation"))) {snapshot("at-failure");}
    }],
    ["private root removal", () => {
      if (!checks.cleanup) {throw new Error("preserving private root because marked processes remain or sweep failed");}
      rmSync(root, { recursive: true, force: true });
      note("cleanup", { survivors, rootRemoved: !existsSync(root) });
    }],
    ["normalize evidence copies", () => normalizeTree(out)],
  ], (failure) => note("cleanup phase failure", failure));
  checks.cleanupPhasesSucceeded = cleanupErrors.length === 0;
  const decision = verdict(checks, journeyCompleted);
  // Final manifest is independent of stop/sweep/copy/removal failures above.
  writeFileSync(join(out, "result.json"), normalizeText(`${JSON.stringify({ ...decision, productionBase: productBase, journeyCompleted, checks, cleanupErrors, events }, null, 2)}\n`));
  console.log(normalizeText(JSON.stringify({ ...decision, checks, out })));
  process.exitCode = decision.exitCode;
}
