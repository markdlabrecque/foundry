#!/usr/bin/env node
// FOU-122 launch gate 3 (explicit stop) probe driver, PRD §17.2 item 3. A disposable fixture, Linux only.
//
// Runs the built Foundry daemon (which starts the real detached Worker Host), the pinned Pi 1.6.0
// in RPC mode for every slot, and the built `foundry` CLI, against two disposable factories:
//   alpha: station eng.hold, 2 instances    beta: station eng.hold, 1 instance
// Every worker loads probe-extension.ts, starts a run that holds the `probe_hold` tool open, and
// leaves a child in the worker's own process group (spawned `detached: false`) that ignores SIGTERM.
//
// Then: `foundry factory stop alpha` (graceful: drain, SIGTERM, grace, SIGKILL) while sampling the
// owned groups' members every 250 ms, observe alpha's groups gone and beta's alive, then
// `foundry shutdown` (sampled the same way), and observe no owned group and no process of this run left.
//
// Usage (after `npm ci && npm run build` at the repo root):
//   node docs/evidence/rpc-54-4-linux/run-probe.mjs [outDir]
// Everything lives under a fresh mktemp root: HOME, XDG dirs, PI_CODING_AGENT_DIR, the state root,
// the Git sources, the worktree roots and the factory YAML. No operator state, credential or network
// is used.
//
// Cleanup: every process this run starts (daemon, host, workers, their children, CLI calls)
// inherits PROBE_DIR=<this run's temp root>/probe, which no other process on the machine carries.
// Cleanup finds them by that marker in /proc/<pid>/environ and SIGKILLs only those, so it reaches
// the detached host and workers even when the run fails early, and never signals a recorded PID
// that has since been reused by an unrelated process.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// Optional explicit selector lets the SDK sibling reuse this exact process/cleanup probe.
const runtime = process.argv[3] ?? "rpc";
if (!["rpc", "sdk"].includes(runtime)) {throw new Error(`unknown runtime: ${runtime}`);}
const outDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "fou122-out-")));
mkdirSync(outDir, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "fou122-"));
const home = join(root, "home");
const user = join(root, "user");
const agentDir = join(root, "agent");
const probeDir = join(root, "probe");

for (const dir of [user, agentDir, probeDir]) {mkdirSync(dir, { recursive: true });}

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));

const env = {
  PATH: process.env.PATH ?? "",
  HOME: user,
  TMPDIR: root, // Keep transpiler caches inside this run, including in isolated Pi children.
  XDG_CONFIG_HOME: join(user, ".config"),
  XDG_DATA_HOME: join(user, ".local/share"),
  XDG_CACHE_HOME: join(user, ".cache"),
  PI_CODING_AGENT_DIR: agentDir,
  FOUNDRY_WORKER_RUNTIME: runtime,
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

const factoryYaml = (name, instances) => `version: 1
name: ${name}
repository:
  source: ./repo-${name}
  default_branch: main
default_production_line: f
worktrees:
  root: ${JSON.stringify(join(root, `worktrees-${name}`))}
rooms:
  eng:
    stations:
      hold:
        model: probe/busy
        isolation: worktree
        instances: ${instances}
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

const files = [];

for (const [name, instances] of [["alpha", 2], ["beta", 1]]) {
  const source = join(root, `repo-${name}`);
  mkdirSync(source);
  git(source, ["init", "--quiet", "--initial-branch", "main"]);
  writeFileSync(join(source, "README.md"), "fixture\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "--quiet", "--no-verify", "-m", "fixture"]);
  const file = join(root, `${name}.yaml`);
  const yaml = factoryYaml(name, instances);
  writeFileSync(file, yaml);
  // The effective fixture as run, with this run's temp paths.
  writeFileSync(join(outDir, `${name}.yaml`), yaml);
  files.push(file);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Signal 0 only probes; it never changes a process. */
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

/** Every process on the machine, with its group, parent and state. */
const ps = () =>
  execFileSync("ps", ["-eo", "pid=,pgid=,ppid=,stat=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), stat: m[4], args: m[5].slice(0, 160) }));

/** Every process whose group is one of `pgids`. */
const membersOf = (pgids) => {
  const wanted = new Set(pgids);
  return ps().filter((m) => wanted.has(m.pgid));
};

/** True when the live process `pid` carries this run's marker. */
const hasMarker = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(PROBE_MARKER);
  } catch {
    return false;
  }
};

/** PIDs of every live process carrying this run's marker: only processes this run started. */
const runProcesses = () =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter(hasMarker);

/** SIGKILLs this run's processes, found by marker, until none is left; returns any that remain. */
const sweep = async () => {
  for (let round = 0; round < 50; round++) {
    const left = runProcesses();

    if (left.length === 0) {return [];}

    for (const pid of left) {
      // Re-checked immediately before the kill, so a PID reused since the scan is never signalled.
      if (!hasMarker(pid)) {continue;}

      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    await sleep(100);
  }

  return runProcesses();
};

const parseBody = (stdout) => {
  try {
    return stdout.trim() === "" ? null : JSON.parse(stdout);
  } catch {
    return { unparsed: stdout.slice(0, 2000) };
  }
};

/**
 * Runs one `foundry` CLI command asynchronously. While it runs, samples the members of `watch`
 * (process group IDs) every 250 ms, keeping a sample only when the membership changes.
 */
const cli = async (args, watch = []) => {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, ...args, "--home", home, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const closed = new Promise((done) => child.once("close", (code, signal) => done({ code, signal })));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const samples = [];
  let lastKey = "";
  let end;

  const sample = () => {
    if (watch.length === 0) {return;}

    const members = membersOf(watch).map(({ pid, pgid, ppid, stat }) => ({ pid, pgid, ppid, stat }));
    const key = JSON.stringify(members);

    if (key !== lastKey) {
      samples.push({ ms: Date.now() - t0, members });
      lastKey = key;
    }
  };

  for (;;) {
    sample();
    end = await Promise.race([closed, sleep(250).then(() => undefined)]);

    if (end !== undefined) {break;}
  }

  // The CLI answers only once the groups are confirmed gone; record the state it answered on.
  sample();
  clearTimeout(timer);

  return {
    argv: ["foundry", ...args, "--home", "<home>", "--json"],
    startedAt,
    exitCode: end.code,
    signal: end.signal,
    ms: Date.now() - t0,
    body: parseBody(stdout),
    stderr: stderr.slice(0, 2000),
    samples,
  };
};

/**
 * From a stop's samples, for one launch: when its leader stopped being a live member (absent or a
 * zombie), when its group emptied, and whether its child was seen alive in the group after the
 * leader had gone, which is what SIGKILL escalation has to end.
 */
const escalationOf = (samples, launch, childPid) => {
  let leaderGoneAtMs = null;
  let groupEmptyAtMs = null;
  let childOutlivedLeader = false;

  for (const sample of samples) {
    const members = sample.members.filter((m) => m.pgid === launch.pgid);
    const leaderLive = members.some((m) => m.pid === launch.pid && !m.stat.startsWith("Z"));
    const childLive = members.some((m) => m.pid === childPid && !m.stat.startsWith("Z"));

    if (!leaderLive && leaderGoneAtMs === null) {leaderGoneAtMs = sample.ms;}

    if (!leaderLive && childLive) {childOutlivedLeader = true;}

    if (members.length === 0 && groupEmptyAtMs === null) {groupEmptyAtMs = sample.ms;}
  }

  return { slot: `${launch.factoryId}/${launch.slotId}`, pgid: launch.pgid, leader: launch.pid, child: childPid, leaderGoneAtMs, groupEmptyAtMs, childOutlivedLeader };
};

const holds = () =>
  readdirSync(probeDir)
    .filter((f) => f.startsWith("hold-"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(probeDir, f), "utf8"))];
      } catch {
        return []; // Still being written; read again on the next poll.
      }
    });

let daemon;
let daemonUp = false;
let result = "inconclusive";
const checks = {};

try {
  note("versions", {
    runtime,
    node: process.version,
    pi: execFileSync(process.execPath, [PI_CLI, "--version"], { env, encoding: "utf8" }).trim(),
    platform: `${process.platform} ${process.arch}`,
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
    foundryCommit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    // Uncommitted changes anywhere in the repo, so a run never cites a commit that is not what ran.
    uncommitted: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean),
  });

  daemon = spawn(process.execPath, [DAEMON, "--home", home, ...files], { env, stdio: ["ignore", "pipe", "pipe"] });
  let daemonOut = "";
  let daemonErr = "";
  daemon.stderr.on("data", (d) => (daemonErr += d));
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`daemon did not serve within 30 s: ${daemonErr}`)), 30_000);
    daemon.stdout.on("data", (d) => {
      daemonOut += d;

      if (daemonOut.includes("management API on")) {
        clearTimeout(timer);
        done();
      }
    });
    daemon.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`daemon exited ${code} before serving: ${daemonErr}`));
    });
  });
  daemonUp = true;
  note("daemon serving", { pid: daemon.pid });

  // Active work: every slot's worker is inside `probe_hold` with its child running.
  for (let waited = 0; holds().length < 3; waited += 200) {
    if (waited > 60_000) {throw new Error(`only ${holds().length} of 3 workers reached probe_hold`);}

    await sleep(200);
  }

  const host = await connectHost(home);
  const hostPid = (await host.identify()).pid;
  const before = await host.inventory();
  host.close();

  const pgids = before.map((l) => l.pgid);
  const holdsBefore = holds();
  const childOf = (launch) => holdsBefore.find((h) => h.launchId === launch.launchId)?.childPid;
  const live = (factoryId) => before.filter((l) => l.factoryId === factoryId && l.liveness === "live");
  const alpha = live("alpha");
  const beta = live("beta");
  const alphaChildren = alpha.map(childOf).filter((pid) => pid !== undefined);
  const betaChildren = beta.map(childOf).filter((pid) => pid !== undefined);

  // One snapshot, used both for the record and for the group-membership check below.
  const membersBefore = membersOf(pgids);
  note("before stop", {
    hostPid,
    launches: before.map(({ launchId, factoryId, slotId, pid, pgid, liveness }) => ({ launchId, factoryId, slotId, pid, pgid, liveness })),
    holds: holdsBefore,
    groupMembers: membersBefore,
  });

  // Two alpha workers and one beta worker, each with its recorded child: no check below can pass on an empty set.
  checks.fixtureShape = alpha.length === 2 && beta.length === 1 && alphaChildren.length === 2 && betaChildren.length === 1;

  // Each worker's child is in the worker's own group, not detached.
  checks.childrenInWorkerGroups =
    holdsBefore.length === 3 &&
    holdsBefore.every((h) => {
      const launch = before.find((l) => l.launchId === h.launchId);
      return launch !== undefined && membersBefore.some((m) => m.pgid === launch.pgid && m.pid === h.childPid);
    });

  const stop = await cli(["factory", "stop", "alpha"], pgids);
  note("factory stop alpha", stop);

  const factories = await cli(["factory", "list"]);
  const afterHost = await connectHost(home);
  const afterStop = await afterHost.inventory();
  afterHost.close();
  const alphaEscalation = alpha.map((l) => escalationOf(stop.samples, l, childOf(l)));
  note("after stop", {
    escalation: alphaEscalation,
    hostRecords: afterStop.map(({ launchId, factoryId, slotId, pid, pgid, liveness, exit }) => ({ launchId, factoryId, slotId, pid, pgid, liveness, exit })),
    alphaGroupsAlive: alpha.map((l) => ({ pgid: l.pgid, alive: groupAlive(l.pgid) })),
    alphaChildrenAlive: alphaChildren.map((pid) => ({ pid, alive: pidAlive(pid) })),
    betaGroupsAlive: beta.map((l) => ({ pgid: l.pgid, alive: groupAlive(l.pgid) })),
    betaChildrenAlive: betaChildren.map((pid) => ({ pid, alive: pidAlive(pid) })),
    groupMembers: membersOf(pgids),
    factories: factories.body,
  });

  const stopped = stop.body?.result;
  const stoppedLaunches = stopped?.launches ?? [];
  checks.stopSucceeded = stop.exitCode === 0 && stopped?.state === "stopped";
  checks.stopNamedOnlyAlpha =
    stoppedLaunches.length === 2 && stoppedLaunches.map((l) => l.launchId).sort().join() === alpha.map((l) => l.launchId).sort().join();
  checks.escalatedEveryAlphaLaunch = stoppedLaunches.length === 2 && stoppedLaunches.every((l) => l.escalated === true);
  checks.alphaChildOutlivedLeader = alphaEscalation.length === 2 && alphaEscalation.every((e) => e.childOutlivedLeader && e.groupEmptyAtMs !== null);
  checks.alphaGroupsGone = alpha.length === 2 && alpha.every((l) => !groupAlive(l.pgid)) && alphaChildren.length === 2 && alphaChildren.every((pid) => !pidAlive(pid));
  checks.betaSurvivesBeforeShutdown =
    beta.length === 1 && beta.every((l) => groupAlive(l.pgid) && pidAlive(l.pid)) && betaChildren.length === 1 && betaChildren.every(pidAlive);

  const down = await cli(["shutdown"], pgids);
  note("shutdown", down);

  for (let waited = 0; daemon.exitCode === null && waited < 10_000; waited += 100) {await sleep(100);}

  for (let waited = 0; pidAlive(hostPid) && waited < 10_000; waited += 100) {await sleep(100);}

  const betaEscalation = beta.map((l) => escalationOf(down.samples, l, childOf(l)));
  const leftover = membersOf(pgids);
  const runLeft = runProcesses();
  note("after shutdown", {
    escalation: betaEscalation,
    daemonExit: daemon.exitCode,
    hostAlive: pidAlive(hostPid),
    groupsAlive: pgids.map((pgid) => ({ pgid, alive: groupAlive(pgid) })),
    childrenAlive: [...alphaChildren, ...betaChildren].map((pid) => ({ pid, alive: pidAlive(pid) })),
    groupMembers: leftover,
    runProcessesLeft: runLeft,
  });

  const downResult = down.body?.result;
  checks.shutdownSucceeded = down.exitCode === 0 && downResult?.hostStopped === true;
  checks.betaChildOutlivedLeader = betaEscalation.length === 1 && betaEscalation.every((e) => e.childOutlivedLeader && e.groupEmptyAtMs !== null);
  checks.noOwnedGroupsAfterShutdown =
    pgids.length === 3 && leftover.length === 0 && pgids.every((g) => !groupAlive(g)) && [...alphaChildren, ...betaChildren].every((p) => !pidAlive(p));
  checks.hostAndDaemonGone = !pidAlive(hostPid) && daemon.exitCode === 0;
  checks.noRunProcessLeft = runLeft.length === 0;

  result = Object.values(checks).every(Boolean) ? "supported" : "failed";
} catch (error) {
  // Once the daemon serves, the platform is available: an error after that is a failure, not inconclusive.
  result = daemonUp ? "failed" : "inconclusive";
  note("error", { message: String(error?.stack ?? error) });
} finally {
  // Clean up only processes this run started, found by marker, whatever happened above.
  const survivors = await sweep();

  if (survivors.length > 0) {note("cleanup incomplete", { pids: survivors });}

  const hostLog = join(home, "logs");

  if (existsSync(hostLog)) {
    const logFiles = readdirSync(hostLog);

    for (const file of logFiles) {writeFileSync(join(outDir, file), readFileSync(join(hostLog, file)));}

    note("state root logs", { files: logFiles, copiedTo: outDir });
  }

  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify({ result, checks, log }, null, 2)}\n`);
  rmSync(root, { recursive: true, force: true });
  note("result", { result, checks, outDir });
}
