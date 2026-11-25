#!/usr/bin/env node
// FOU-108 probe driver: RPC Tool Set mismatch and collision (PRD §17.2 gate 2, last three bullets).
//
// Runs the built Foundry daemon, which starts the real detached Worker Host, which launches the
// pinned Pi in RPC mode with the Foundry extension. Each variant gets a fresh mktemp root with its
// own HOME, XDG dirs, PI_CODING_AGENT_DIR, state root and a local Git repository; nothing touches
// the operator's ~/.pi or ~/.foundry. The model comes from a `models.json` provider pointing at a
// closed local port, so no extension is needed to supply it and no model call is ever made: the
// Tool Set check happens at the worker's `hello`, at session start.
//
// Usage (from the repository root, after `npm ci && npm run build`):
//   node docs/evidence/rpc-53-3-linux/run-probe.mjs [outDir]
//
// Variants:
//   missing     YAML names probe_absent on an extension that never registers it (it registers
//               the unnamed probe_unnamed instead).
//   reserved    A configured extension registers Pi's reserved `read`.
//   agent-name  A configured extension registers the agent tool name `agent_message`.
//   cleared     The factory default names probe_named on named.ts; station `inherit` keeps it,
//               station `cleared` sets `extensions: []`.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const fixtures = join(here, "fixtures");
const daemonMain = join(repo, "packages/daemon/dist/main.js");
const cliMain = join(repo, "packages/cli/dist/main.js");
const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const outDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "fou108-out-")));
mkdirSync(outDir, { recursive: true });

const MODEL = "probe-local/inert";
const MODELS_JSON = {
  providers: {
    "probe-local": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "inert" }] },
  },
};

const line = (stations) => `production_lines:
  f:
    verify: ["true"]
    stages:
${stations.map((s, i) => `      - id: s${i}\n        station: eng.${s}\n        writing: ${i === 0}`).join("\n")}
      - id: approve
        station: eng.${stations[0]}
        approval: true
        on_rejection: s0
`;

const header = (defaults = "") => `version: 1
name: probe
repository:
  source: ./repo
  default_branch: main
default_production_line: f
${defaults}rooms:
  eng:
    stations:
`;

const ext = (file, tools) => `{ path: ${JSON.stringify(join(fixtures, file))}, tools: [${tools.join(", ")}] }`;

const VARIANTS = {
  missing: {
    yaml: `${header()}      dev:
        isolation: worktree
        model: ${MODEL}
        extensions: [${ext("missing.ts", ["probe_absent"])}]
${line(["dev"])}`,
    slots: ["dev/1"],
  },
  reserved: {
    yaml: `${header()}      dev:
        isolation: worktree
        model: ${MODEL}
        extensions: [${ext("reserved.ts", ["probe_named"])}]
${line(["dev"])}`,
    slots: ["dev/1"],
  },
  "agent-name": {
    yaml: `${header()}      dev:
        isolation: worktree
        model: ${MODEL}
        extensions: [${ext("agent-name.ts", ["probe_named"])}]
${line(["dev"])}`,
    slots: ["dev/1"],
  },
  cleared: {
    yaml: `${header(`defaults:
  extensions: [${ext("named.ts", ["probe_named"])}]
`)}      inherit:
        isolation: worktree
        model: ${MODEL}
      cleared:
        isolation: worktree
        model: ${MODEL}
        extensions: []
${line(["inherit", "cleared"])}`,
    slots: ["inherit/1", "cleared/1"],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJsonl = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];

const poll = async (what, check, timeoutMs = 30_000) => {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
};

async function runVariant(name, { yaml, slots }) {
  const root = mkdtempSync(join(tmpdir(), `fou108-${name}-`));
  const home = join(root, "home");
  const user = join(root, "user");
  const agent = join(root, "agent");
  const markers = join(root, "markers");
  for (const d of [user, agent, markers]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
  writeFileSync(join(agent, "models.json"), JSON.stringify(MODELS_JSON));

  const gitEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Probe", GIT_AUTHOR_EMAIL: "probe@foundry.invalid",
    GIT_COMMITTER_NAME: "Probe", GIT_COMMITTER_EMAIL: "probe@foundry.invalid",
  };
  const env = {
    PATH: process.env.PATH,
    ...gitEnv,
    HOME: user,
    XDG_CONFIG_HOME: join(user, ".config"),
    XDG_DATA_HOME: join(user, ".local/share"),
    XDG_CACHE_HOME: join(user, ".cache"),
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    FOUNDRY_HOME: join(root, "not-this-one"),
    PROBE_MARKER_DIR: markers,
    // Records each launch's exact argv (Pi blanks /proc/<pid>/cmdline once it sets its title).
    NODE_OPTIONS: `--import=${join(fixtures, "record-argv.mjs")}`,
  };

  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  const git = (args) => execFileSync("git", args, { cwd: repoDir, env, stdio: "ignore" });
  git(["init", "--quiet", "--initial-branch", "main"]);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "--no-verify", "-m", "fixture"]);

  const factory = join(root, "factory.yaml");
  writeFileSync(factory, yaml);

  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cliMain, ...args, "--home", home], { env, encoding: "utf8" }) };
    } catch (error) {
      return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };

  const result = { variant: name, root, factoryYaml: yaml };

  // The effective fixture as Foundry resolves it, before anything is launched.
  try {
    result.validate = { code: 0, out: execFileSync(process.execPath, [cliMain, "validate", factory], { env, encoding: "utf8" }) };
  } catch (error) {
    result.validate = { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }

  const daemon = spawn(process.execPath, [daemonMain, "--home", home, factory], { env, stdio: ["ignore", "pipe", "pipe"] });
  let daemonOut = "";
  daemon.stdout.on("data", (c) => (daemonOut += c));
  daemon.stderr.on("data", (c) => (daemonOut += c));

  try {
    await poll("the management API", () => daemonOut.includes("management API on") || (daemon.exitCode !== null && (() => { throw new Error(`daemon exited: ${daemonOut}`); })()));
    const log = () => readJsonl(join(home, "logs/daemon.log"));
    const outcomes = (l) => l.filter((e) => e.msg === "channel accepted" || e.msg === "channel hello refused");
    await poll("every slot's hello", () => outcomes(log()).length >= slots.length);
    // A refused hello freezes the slot and has the host stop the launch; give both time to land.
    if (outcomes(log()).some((e) => e.msg === "channel hello refused")) {
      await poll("the mismatched launch to end", () => log().some((e) => e.msg === "launch ended"));
    }
    await sleep(500);

    result.daemonLog = log()
      .filter((e) => /channel|launch|frozen|freeze|mismatch|relaunch/.test(e.msg))
      .map(({ time, ...rest }) => rest);
    result.holdList = cli("hold", "list");
    const holds = JSON.parse(cli("hold", "list", "--json").out).result.holds;
    result.holdShow = holds.map((h) => cli("hold", "show", String(h.id)));
    result.slotList = cli("slot", "list");
    result.slotShow = slots.map((s) => cli("slot", "show", s));
    result.markers = Object.fromEntries(readdirSync(markers).sort().map((f) => {
      const text = readFileSync(join(markers, f), "utf8");
      return [f, f.endsWith(".log") ? text : JSON.parse(text)];
    }));
  } finally {
    result.shutdown = cli("shutdown", "--force");
    await poll("the daemon to exit", () => daemon.exitCode !== null || daemon.signalCode !== null, 20_000).catch(() => daemon.kill("SIGKILL"));
    // Removed even when the variant failed, so an aborted run leaves no disposable root behind.
    rmSync(root, { recursive: true, force: true });
  }

  return result;
}

const versions = {
  pi: execFileSync(process.execPath, [piCli, "--version"], { encoding: "utf8", env: { PATH: process.env.PATH, PI_OFFLINE: "1" } }).trim(),
  node: process.version,
  platform: `${process.platform} ${execFileSync("uname", ["-r"], { encoding: "utf8" }).trim()}`,
  foundry: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
};
writeFileSync(join(outDir, "versions.json"), JSON.stringify(versions, null, 2));
console.log(versions);

for (const [name, variant] of Object.entries(VARIANTS)) {
  const result = await runVariant(name, variant);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2));
  console.log(`${name}: written ${join(outDir, `${name}.json`)}`);
}
