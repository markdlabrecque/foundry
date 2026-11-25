#!/usr/bin/env node
// FOU-122 launch gate 3 (explicit stop) probe driver, PRD §17.2 item 3. A disposable fixture.
//
// Runs the built Foundry daemon (which starts the real detached Worker Host), the pinned Pi 1.6.0
// in RPC mode for every slot, and the built `foundry` CLI, against two disposable factories:
//   alpha: station eng.hold, 2 instances    beta: station eng.hold, 1 instance
// Every worker loads probe-extension.ts, starts a run that holds the `probe_hold` tool open, and
// leaves a non-detached child in its process group that ignores SIGTERM.
//
// Then: `foundry factory stop alpha` (graceful: drain, SIGTERM, grace, SIGKILL), observe alpha's
// groups gone and beta's alive, then `foundry shutdown`, and observe no owned group left.
//
// Usage (after `npm ci && npm run build` at the repo root):
//   node docs/evidence/rpc-54-4-linux/run-probe.mjs [outDir]
// Everything lives under a fresh mktemp root: HOME, XDG dirs, PI_CODING_AGENT_DIR, the state root,
// the Git sources and the factory YAML. No operator state, credential or network is used.

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
  PROBE_DIR: probeDir,
};

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
  root: ${JSON.stringify(join(root, "worktrees"))}
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
  writeFileSync(file, factoryYaml(name, instances));
  files.push(file);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

/** Every process on the machine whose group is one of `pgids`. */
const membersOf = (pgids) => {
  const wanted = new Set(pgids);
  return execFileSync("ps", ["-eo", "pid=,pgid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m !== null && wanted.has(Number(m[2])))
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), args: m[4].slice(0, 160) }));
};

const cli = (args) => {
  const started = Date.now();
  let stdout = "";
  let exitCode = 0;

  try {
    stdout = execFileSync(process.execPath, [CLI, ...args, "--home", home, "--json"], { env, encoding: "utf8", timeout: 90_000 });
  } catch (error) {
    stdout = String(error.stdout ?? "");
    exitCode = error.status ?? -1;
  }

  return { argv: ["foundry", ...args, "--home", "<home>", "--json"], exitCode, ms: Date.now() - started, body: stdout.trim() === "" ? null : JSON.parse(stdout) };
};

const holds = () =>
  readdirSync(probeDir)
    .filter((f) => f.startsWith("hold-"))
    .map((f) => JSON.parse(readFileSync(join(probeDir, f), "utf8")));

let daemon;
let hostPid;
const allPgids = new Set();
const allChildPids = new Set();
let result = "inconclusive";
const checks = {};

try {
  note("versions", {
    node: process.version,
    pi: execFileSync(process.execPath, [PI_CLI, "--version"], { env, encoding: "utf8" }).trim(),
    platform: `${process.platform} ${process.arch}`,
    kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
  });

  daemon = spawn(process.execPath, [DAEMON, "--home", home, ...files], { env, stdio: ["ignore", "pipe", "pipe"] });
  let daemonOut = "";
  let daemonErr = "";
  daemon.stderr.on("data", (d) => (daemonErr += d));
  await new Promise((done, fail) => {
    daemon.stdout.on("data", (d) => {
      daemonOut += d;
      if (daemonOut.includes("management API on")) {done();}
    });
    daemon.once("exit", (code) => fail(new Error(`daemon exited ${code} before serving: ${daemonErr}`)));
  });
  note("daemon serving", { pid: daemon.pid });

  // Active work: every slot's worker is inside `probe_hold` with its child running.
  for (let waited = 0; holds().length < 3; waited += 200) {
    if (waited > 60_000) {throw new Error(`only ${holds().length} of 3 workers reached probe_hold`);}
    await sleep(200);
  }

  const host = await connectHost(home);
  hostPid = (await host.identify()).pid;
  const before = await host.inventory();
  host.close();

  for (const launch of before) {allPgids.add(launch.pgid);}
  for (const hold of holds()) {allChildPids.add(hold.childPid);}

  const groupsOf = (factoryId) => before.filter((l) => l.factoryId === factoryId && l.liveness === "live");
  const alpha = groupsOf("alpha");
  const beta = groupsOf("beta");
  const holdsBefore = holds();

  note("before stop", {
    hostPid,
    launches: before.map(({ launchId, factoryId, slotId, pid, pgid, liveness }) => ({ launchId, factoryId, slotId, pid, pgid, liveness })),
    holds: holdsBefore,
    groupMembers: membersOf([...allPgids]),
  });

  // Each worker's child is in the worker's own group, not detached.
  checks.childrenInWorkerGroups = holdsBefore.every((h) => {
    const launch = before.find((l) => l.launchId === h.launchId);
    return launch !== undefined && membersOf([launch.pgid]).some((m) => m.pid === h.childPid);
  });

  const stopStartedAt = new Date().toISOString();
  const stop = cli(["factory", "stop", "alpha"]);
  note("factory stop alpha", { startedAt: stopStartedAt, ...stop });

  const alphaChildren = holdsBefore.filter((h) => h.factoryId === "alpha").map((h) => h.childPid);
  const betaChildren = holdsBefore.filter((h) => h.factoryId === "beta").map((h) => h.childPid);
  const factories = cli(["factory", "list"]);
  const afterHost = await connectHost(home);
  const afterStop = await afterHost.inventory();
  afterHost.close();
  note("after stop", {
    hostRecords: afterStop.map(({ factoryId, slotId, pgid, liveness, exit }) => ({ factoryId, slotId, pgid, liveness, exit })),
    alphaGroupsAlive: alpha.map((l) => ({ pgid: l.pgid, alive: groupAlive(l.pgid) })),
    alphaChildrenAlive: alphaChildren.map((pid) => ({ pid, alive: pidAlive(pid) })),
    betaGroupsAlive: beta.map((l) => ({ pgid: l.pgid, alive: groupAlive(l.pgid) })),
    betaChildrenAlive: betaChildren.map((pid) => ({ pid, alive: pidAlive(pid) })),
    groupMembers: membersOf([...allPgids]),
    factories: factories.body,
  });

  const stopped = stop.body?.result;
  checks.stopSucceeded = stop.exitCode === 0 && stopped?.state === "stopped";
  checks.stopNamedOnlyAlpha =
    (stopped?.launches ?? []).map((l) => l.launchId).sort().join() === alpha.map((l) => l.launchId).sort().join();
  checks.escalatedEveryAlphaLaunch = (stopped?.launches ?? []).length === alpha.length && stopped.launches.every((l) => l.escalated);
  checks.alphaGroupsGone = alpha.every((l) => !groupAlive(l.pgid)) && alphaChildren.every((pid) => !pidAlive(pid));
  checks.betaSurvivesBeforeShutdown = beta.length === 1 && beta.every((l) => groupAlive(l.pgid) && pidAlive(l.pid)) && betaChildren.every(pidAlive);

  const downStartedAt = new Date().toISOString();
  const down = cli(["shutdown"]);
  note("shutdown", { startedAt: downStartedAt, ...down });

  for (let waited = 0; daemon.exitCode === null && waited < 10_000; waited += 100) {await sleep(100);}
  for (let waited = 0; pidAlive(hostPid) && waited < 10_000; waited += 100) {await sleep(100);}

  const leftover = membersOf([...allPgids]);
  note("after shutdown", {
    daemonExit: daemon.exitCode,
    hostAlive: pidAlive(hostPid),
    groupsAlive: [...allPgids].map((pgid) => ({ pgid, alive: groupAlive(pgid) })),
    childrenAlive: [...allChildPids].map((pid) => ({ pid, alive: pidAlive(pid) })),
    groupMembers: leftover,
  });

  checks.shutdownSucceeded = down.exitCode === 0 && down.body?.result?.hostStopped === true;
  checks.noOwnedGroupsAfterShutdown = leftover.length === 0 && [...allPgids].every((g) => !groupAlive(g)) && [...allChildPids].every((p) => !pidAlive(p));
  checks.hostAndDaemonGone = !pidAlive(hostPid) && daemon.exitCode === 0;

  result = Object.values(checks).every(Boolean) ? "supported" : "failed";
} catch (error) {
  note("error", { message: String(error?.stack ?? error) });
} finally {
  // Clean up anything this run started, whatever happened above.
  for (const pgid of allPgids) {try { process.kill(-pgid, "SIGKILL"); } catch {}}
  for (const pid of allChildPids) {try { process.kill(pid, "SIGKILL"); } catch {}}
  if (hostPid !== undefined) {try { process.kill(hostPid, "SIGKILL"); } catch {}}
  if (daemon !== undefined && daemon.exitCode === null) {daemon.kill("SIGKILL");}
  const hostLog = join(home, "logs");
  if (existsSync(hostLog)) {
    const files = readdirSync(hostLog);
    for (const file of files) {writeFileSync(join(outDir, file), readFileSync(join(hostLog, file)));}
    note("state root logs", { files, copiedTo: outDir });
  }
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify({ result, checks, log }, null, 2)}\n`);
  rmSync(root, { recursive: true, force: true });
  note("result", { result, checks, outDir });
}
