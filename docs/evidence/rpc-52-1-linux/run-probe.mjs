#!/usr/bin/env node
// FOU-83 launch gate 1 (survival and reconnect) probe driver, PRD §17.2 item 1. A disposable fixture, Linux only.
//
// Runs the built Foundry daemon (which starts the real detached Worker Host) and the pinned Pi 1.6.0
// in RPC mode for every slot, against one disposable factory `alpha` with station eng.hold, 2 instances.
// Every worker loads probe-extension.ts and holds a run open in `probe_hold`, so both are busy.
//
// Then: record both launches and their channels, SIGKILL only the daemon, observe the workers and the
// host still alive, start the daemon again on the same state root, and observe for RECONNECT_WINDOW_MS
// whether both original launches reconnect (a `channel accepted` for each original launch ID in the
// restarted daemon's log, followed by channel frames), keep their slots, and are not replaced.
// Finally `foundry shutdown`, and cleanup.
//
// Usage (after `npm ci && npm run build` at the repo root):
//   node docs/evidence/rpc-52-1-linux/run-probe.mjs [outDir]
// Everything lives under a fresh mktemp root: HOME, XDG dirs, PI_CODING_AGENT_DIR, the state root,
// the Git source, the worktree root and the factory YAML. No operator state, credential or network
// is used.
//
// Cleanup: every process this run starts inherits PROBE_DIR=<this run's temp root>/probe, which no
// other process on the machine carries. Cleanup finds them by that marker in /proc/<pid>/environ and
// SIGKILLs only those (as in rpc-54-4-linux/run-probe.mjs).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectHost } from "@foundry/host";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const DAEMON = join(repo, "packages/daemon/dist/main.js");
const CLI = join(repo, "packages/cli/dist/main.js");
const PROBE_EXTENSION = join(here, "probe-extension.ts");
const PI_CLI = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

/** Three channel-loss windows (CHANNEL_LOST_AFTER_MS 15 s) after the restarted daemon serves. */
const RECONNECT_WINDOW_MS = 45_000;

const outDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "fou83-out-")));
mkdirSync(outDir, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "fou83-"));
const home = join(root, "home");
const user = join(root, "user");
const agentDir = join(root, "agent");
const probeDir = join(root, "probe");

for (const dir of [user, agentDir, probeDir]) {mkdirSync(dir, { recursive: true });}

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));

const env = {
  PATH: process.env.PATH ?? "",
  HOME: user,
  XDG_CONFIG_HOME: join(user, ".config"),
  XDG_DATA_HOME: join(user, ".local/share"),
  XDG_CACHE_HOME: join(user, ".cache"),
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  FOUNDRY_HOME: join(root, "not-this-one"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Foundry Fixture",
  GIT_AUTHOR_EMAIL: "fixture@foundry.invalid",
  GIT_COMMITTER_NAME: "Foundry Fixture",
  GIT_COMMITTER_EMAIL: "fixture@foundry.invalid",
  // Also this run's process marker (see the header); this driver itself does not carry it.
  PROBE_DIR: probeDir,
};

const PROBE_MARKER = `PROBE_DIR=${probeDir}`;

const log = [];
const note = (event, detail = {}) => {
  const entry = { at: new Date().toISOString(), event, ...detail };
  log.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

const yaml = `version: 1
name: alpha
repository:
  source: ./repo-alpha
  default_branch: main
default_production_line: f
worktrees:
  root: ${JSON.stringify(join(root, "worktrees-alpha"))}
rooms:
  eng:
    stations:
      hold:
        model: probe/busy
        isolation: worktree
        instances: 2
        extensions:
          - path: ${JSON.stringify(PROBE_EXTENSION)}
            tools: [probe_hold]
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: a
        station: eng.hold
        writing: true
      - id: b
        station: eng.hold
        approval: true
        on_rejection: a
`;

const source = join(root, "repo-alpha");
mkdirSync(source);
git(source, ["init", "--quiet", "--initial-branch", "main"]);
writeFileSync(join(source, "README.md"), "fixture\n");
git(source, ["add", "README.md"]);
git(source, ["commit", "--quiet", "--no-verify", "-m", "fixture"]);
const factoryFile = join(root, "alpha.yaml");
writeFileSync(factoryFile, yaml);
writeFileSync(join(outDir, "alpha.yaml"), yaml);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

const hasMarker = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(PROBE_MARKER);
  } catch {
    return false;
  }
};

const runProcesses = () =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter(hasMarker);

const sweep = async () => {
  for (let round = 0; round < 50; round++) {
    const left = runProcesses();

    if (left.length === 0) {return [];}

    for (const pid of left) {
      if (!hasMarker(pid)) {continue;}

      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    await sleep(100);
  }

  return runProcesses();
};

/**
 * Established Unix stream sockets held only by `pid` (not descriptors inherited by many processes),
 * each with the PIDs holding its peer end, from `ss -xp`.
 */
const unixSocketsOf = (pid) => {
  const rows = execFileSync("ss", ["-xpH", "state", "established"], { encoding: "utf8" })
    .split("\n")
    // With the state filter a row is: u_str <recv-q> <send-q> * <inode> * <peer-inode> users:((...)).
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 7 && /^\d+$/.test(cols[4]) && /^\d+$/.test(cols[6]))
    .map((cols) => ({
      local: cols[4],
      peer: cols[6],
      pids: [...cols.slice(7).join(" ").matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])),
    }));
  const byInode = new Map(rows.map((r) => [r.local, r]));

  return rows
    .filter((r) => r.pids.length === 1 && r.pids[0] === pid)
    .map((r) => ({ inode: r.local, peerInode: r.peer, peerPids: byInode.get(r.peer)?.pids ?? [] }));
};

const parseBody = (stdout) => {
  try {
    return stdout.trim() === "" ? null : JSON.parse(stdout);
  } catch {
    return { unparsed: stdout.slice(0, 2000) };
  }
};

const cli = async (args) => {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, ...args, "--home", home, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const end = await new Promise((done) => child.once("close", (code, signal) => done({ code, signal })));
  clearTimeout(timer);

  return {
    argv: ["foundry", ...args, "--home", "<home>", "--json"],
    startedAt,
    exitCode: end.code,
    signal: end.signal,
    ms: Date.now() - t0,
    body: parseBody(stdout),
    stderr: stderr.slice(0, 2000),
  };
};

/** Starts the built daemon at debug level (every channel frame is logged by type); resolves once it serves. */
const startDaemon = async () => {
  const child = spawn(process.execPath, [DAEMON, "--home", home, "--log-level", "debug", factoryFile], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`daemon did not serve within 30 s: ${err}`)), 30_000);
    child.stdout.on("data", (d) => {
      out += d;

      if (out.includes("management API on")) {
        clearTimeout(timer);
        done();
      }
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      fail(new Error(`daemon exited ${code ?? signal} before serving: ${err}`));
    });
  });

  return { child, exited, stderr: () => err };
};

const daemonLogFile = join(home, "logs", "daemon.log");
const daemonLogSize = () => (existsSync(daemonLogFile) ? statSync(daemonLogFile).size : 0);

/** Daemon log lines written from byte `from` on, parsed. */
const daemonLogFrom = (from) => {
  if (!existsSync(daemonLogFile)) {return [];}

  return readFileSync(daemonLogFile).subarray(from).toString("utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
};

/** Per launch: the first `channel accepted`, losses, and frame types seen after the accept. */
const channelActivity = (lines, launchIds) =>
  Object.fromEntries(launchIds.map((launchId) => {
    const own = lines.filter((l) => l.launchId === launchId);
    const accepted = own.filter((l) => l.msg === "channel accepted");
    const firstAccept = accepted[0]?.time ?? null;
    const frames = own.filter((l) => l.msg === "channel frame" && firstAccept !== null && l.time >= firstAccept);
    const frameCounts = {};

    for (const f of frames) {frameCounts[f.detail?.frame ?? "?"] = (frameCounts[f.detail?.frame ?? "?"] ?? 0) + 1;}

    return [launchId, {
      accepted: accepted.map((l) => l.time),
      lost: own.filter((l) => l.msg === "channel lost").map((l) => ({ time: l.time, cause: l.detail?.cause })),
      frameCounts,
      lastFrameAt: frames.at(-1)?.time ?? null,
    }];
  }));

const holds = () =>
  readdirSync(probeDir)
    .filter((f) => f.startsWith("hold-"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(probeDir, f), "utf8"))];
      } catch {
        return [];
      }
    });

const slotLaunches = (body) => (body?.result?.slots ?? []).map((s) => ({ slotId: s.slotId, condition: s.condition, freezeCause: s.freezeCause, launchId: s.launch?.launchId ?? null, endedAt: s.launch?.endedAt ?? null }));

let first;
let second;
let daemonUp = false;
let result = "inconclusive";
const checks = {};

try {
  note("versions", {
    node: process.version,
    pi: execFileSync(process.execPath, [PI_CLI, "--version"], { env, encoding: "utf8" }).trim(),
    platform: `${process.platform} ${process.arch}`,
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
    foundryCommit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    uncommitted: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean),
  });

  first = await startDaemon();
  daemonUp = true;
  note("first daemon serving", { pid: first.child.pid });

  // Busy: both workers are inside `probe_hold`.
  for (let waited = 0; holds().length < 2; waited += 200) {
    if (waited > 60_000) {throw new Error(`only ${holds().length} of 2 workers reached probe_hold`);}

    await sleep(200);
  }

  // Let a few heartbeats pass so the first run's channel traffic is on record.
  await sleep(6_000);

  const host = await connectHost(home);
  const identityBefore = await host.identify();
  const before = await host.inventory();
  host.close();
  const live = before.filter((l) => l.liveness === "live");
  const launchIds = live.map((l) => l.launchId).sort();
  const holdsBefore = holds();
  const slotsBefore = await cli(["slot", "list"]);
  const firstRunLog = daemonLogFrom(0);
  const channelsBefore = channelActivity(firstRunLog, launchIds);
  const socketsBefore = Object.fromEntries(live.map((l) => [l.launchId, unixSocketsOf(l.pid)]));

  note("before kill", {
    host: { pid: identityBefore.pid, hostId: identityBefore.hostId, bootId: identityBefore.bootId },
    launches: before.map(({ launchId, factoryId, slotId, pid, pgid, liveness }) => ({ launchId, factoryId, slotId, pid, pgid, liveness })),
    holds: holdsBefore,
    slots: slotLaunches(slotsBefore.body),
    channels: channelsBefore,
    workerUnixSockets: socketsBefore,
  });

  checks.fixtureShape = live.length === 2 && before.length === 2 && holdsBefore.length === 2 &&
    new Set(live.map((l) => l.slotId)).size === 2;
  checks.connectedBeforeKill = launchIds.length === 2 && launchIds.every((id) => channelsBefore[id].accepted.length === 1 &&
    (channelsBefore[id].frameCounts.heartbeat ?? 0) > 0);

  // Abrupt kill of the daemon only.
  const killedAt = new Date().toISOString();
  first.child.kill("SIGKILL");
  const firstExit = await first.exited;
  daemonUp = false;
  await sleep(2_000);
  const afterKill = {
    killedAt,
    daemonExit: firstExit,
    hostAlive: pidAlive(identityBefore.pid),
    workersAlive: live.map((l) => ({ launchId: l.launchId, pid: l.pid, alive: pidAlive(l.pid) })),
    workerUnixSockets: Object.fromEntries(live.map((l) => [l.launchId, unixSocketsOf(l.pid)])),
  };
  note("after kill", afterKill);

  checks.daemonKilledAbruptly = firstExit.signal === "SIGKILL";
  checks.workersAndHostSurviveKill = afterKill.hostAlive && live.length === 2 && afterKill.workersAlive.every((w) => w.alive);

  // Restart on the same state root.
  const logOffset = daemonLogSize();
  second = await startDaemon();
  daemonUp = true;
  const restartedAt = new Date().toISOString();
  note("second daemon serving", { pid: second.child.pid, restartedAt });

  // Observe until both original launches have reconnected and sent frames, or the window ends.
  const t0 = Date.now();
  let channelsAfter = channelActivity(daemonLogFrom(logOffset), launchIds);

  while (Date.now() - t0 < RECONNECT_WINDOW_MS) {
    channelsAfter = channelActivity(daemonLogFrom(logOffset), launchIds);

    if (launchIds.every((id) => channelsAfter[id].accepted.length > 0 && (channelsAfter[id].frameCounts.heartbeat ?? 0) >= 2)) {break;}

    await sleep(1_000);
  }

  const observedMs = Date.now() - t0;
  const host2 = await connectHost(home);
  const identityAfter = await host2.identify();
  const after = await host2.inventory();
  host2.close();
  const slotsAfter = await cli(["slot", "list"]);
  const holdsList = await cli(["hold", "list"]);
  const secondRunLog = daemonLogFrom(logOffset);
  const notable = secondRunLog.filter((l) => l.level === "warn" || l.level === "error" ||
    ["channel accepted", "channel hello refused", "channel lost", "slot relaunched", "launch ended", "daemon started"].includes(l.msg));
  const afterSlots = slotLaunches(slotsAfter.body);

  note("after restart", {
    observedMs,
    host: { pid: identityAfter.pid, hostId: identityAfter.hostId, bootId: identityAfter.bootId },
    launches: after.map(({ launchId, factoryId, slotId, pid, pgid, liveness }) => ({ launchId, factoryId, slotId, pid, pgid, liveness })),
    workersAlive: live.map((l) => ({ launchId: l.launchId, pid: l.pid, alive: pidAlive(l.pid) })),
    slots: afterSlots,
    holds: holdsList.body,
    channels: channelsAfter,
    workerUnixSockets: Object.fromEntries(live.map((l) => [l.launchId, unixSocketsOf(l.pid)])),
    notableDaemonLog: notable,
    probeHoldsNow: holds(),
  });

  checks.sameHostAfterRestart = identityAfter.hostId === identityBefore.hostId && identityAfter.pid === identityBefore.pid;
  checks.workersStillAlive = live.length === 2 && live.every((l) => pidAlive(l.pid));
  checks.sameLaunchesInSlots = afterSlots.length === 2 && live.every((l) =>
    afterSlots.some((s) => s.slotId === l.slotId && s.launchId === l.launchId && s.endedAt === null && s.condition === "normal"));
  checks.noReplacement = after.length === 2 && after.every((l) => launchIds.includes(l.launchId) && l.liveness === "live") &&
    holds().length === 2;
  checks.reconnectedToRestartedDaemon = launchIds.every((id) => channelsAfter[id].accepted.length > 0);
  checks.channelTrafficResumed = launchIds.every((id) => (channelsAfter[id].frameCounts.heartbeat ?? 0) >= 2);

  const down = await cli(["shutdown"]);
  note("shutdown", down);
  await Promise.race([second.exited, sleep(15_000)]);

  for (let waited = 0; pidAlive(identityBefore.pid) && waited < 10_000; waited += 100) {await sleep(100);}

  const runLeft = runProcesses();
  note("after shutdown", { daemonExit: second.child.exitCode, hostAlive: pidAlive(identityBefore.pid), runProcessesLeft: runLeft });
  checks.shutdownLeavesNothing = down.exitCode === 0 && runLeft.length === 0;

  // `blocked`: blocked on the tested approach, the ticket's label for a reproducible failure.
  result = Object.values(checks).every(Boolean) ? "supported" : "blocked";
} catch (error) {
  result = daemonUp || first !== undefined ? "blocked" : "inconclusive";
  note("error", { message: String(error?.stack ?? error) });
} finally {
  const survivors = await sweep();

  if (survivors.length > 0) {note("cleanup incomplete", { pids: survivors });}

  const logs = join(home, "logs");

  if (existsSync(logs)) {
    const logFiles = readdirSync(logs).filter((f) => statSync(join(logs, f)).isFile());

    for (const file of logFiles) {writeFileSync(join(outDir, file), readFileSync(join(logs, file)));}

    note("state root logs", { files: logFiles, copiedTo: outDir });
  }

  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify({ result, checks, log }, null, 2)}\n`);
  rmSync(root, { recursive: true, force: true });
  note("result", { result, checks, outDir });
}
