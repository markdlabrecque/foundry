// Integration tier: the claim is about what a real daemon start leaves behind — the exit code and
// message on refusal, the run and configuration-load rows in the state root's database, and the
// knowledge directories on disk — so it runs the built foreground daemon against temp dirs.
// Validation rules themselves are covered by the config unit tests; one invalid case suffices here.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { DATABASE_FILE_NAME, openStore } from "@foundry/daemon";
import { runFactoryList } from "@foundry/cli";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");
// The version the daemon records is its package's.
const daemonVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@foundry/daemon")), "utf8")) as { version: string }
).version;
const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

/** Runs the built `foundry` CLI without blocking, so the daemon's pipes keep draining. */
const foundry = (args: ReadonlyArray<string>, home: string): Promise<{ code: number | null; stderr: string }> =>
  new Promise((done) => {
    execFile(
      process.execPath,
      [cliMain, ...args],
      { env: { ...process.env, FOUNDRY_HOME: join(home, "not-this-one") }, timeout: 20_000 },
      (error, _stdout, stderr) => done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stderr }),
    );
  });

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-load-"));
  roots.push(root);
  return root;
};

const factoryYaml = (name: string): string => `version: 1
name: ${name}
repository:
  source: ./repo
  default_branch: main
default_production_line: f
rooms:
  eng:
    stations:
      dev: { isolation: worktree, model: p/m }
      rev: { isolation: worktree, model: p/m }
production_lines:
  f:
    verify: [npm, test]
    stages:
      - id: a
        station: eng.dev
        writing: true
      - id: b
        station: eng.rev
        approval: true
        on_rejection: a
`;

/** A disposable factory directory with its repository source; returns the YAML path. */
const factoryDir = (yaml: string): string => {
  const dir = tempRoot();
  mkdirSync(join(dir, "repo"));
  const file = join(dir, "factory.yaml");
  writeFileSync(file, yaml);
  return file;
};

interface Run {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
  readonly serving: Promise<void>;
}

const startDaemon = (home: string, files: ReadonlyArray<string>, env: Record<string, string> = {}): Run => {
  // FOUNDRY_HOME points elsewhere so the operator's root is never used.
  const child = spawn(process.execPath, [daemonMain, "--home", home, ...files], {
    env: { ...process.env, ...env, FOUNDRY_HOME: join(home, "not-this-one") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.on("exit", (code) => done({ code, stdout, stderr })),
  );
  const serving = new Promise<void>((done, fail) => {
    child.stdout!.on("data", () => stdout.includes("management API on") && done());
    void exited.then(({ code }) => fail(new Error(`daemon exited ${code}: ${stderr}`)));
  });
  // A run expected to be refused never awaits `serving`; keep its rejection from going unhandled.
  serving.catch(() => {});
  return { child, exited, serving };
};

/** Starts the daemon, waits until it serves, runs `whileServing`, and stops it cleanly. */
const runOnce = async (
  home: string,
  files: ReadonlyArray<string>,
  env: Record<string, string>,
  whileServing?: () => Promise<void>,
): Promise<void> => {
  const run = startDaemon(home, files, env);
  await run.serving;
  await whileServing?.();
  run.child.kill("SIGTERM");
  expect((await run.exited).code).toBe(0);
};

const readState = (home: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(openStore({ filename: join(home, DATABASE_FILE_NAME) }), (store) =>
        Effect.all({
          runs: store.read<{ id: string; version: string }>(`SELECT id, version FROM run ORDER BY started_at, rowid`),
          loads: store.read<{ id: number; run_id: string; factory_id: string; config: string; config_hash: string; knowledge_root: string }>(
            `SELECT id, run_id, factory_id, config, config_hash, knowledge_root FROM factory_config_load ORDER BY id`,
          ),
          transitions: store.read<{ factory_id: string; ticket_number: number; config_load: string | null }>(
            `SELECT factory_id, ticket_number, config_load FROM ticket_transition ORDER BY sequence`,
          ),
          history: store.read<{ factory_id: string; kind: string; subject: string }>(
            `SELECT factory_id, kind, subject FROM history ORDER BY sequence`,
          ),
        }),
      ),
    ),
  );

test("an invalid factory refuses start with one line and exit 1, leaving the state root untouched", async () => {
  const home = join(tempRoot(), "home");
  const file = factoryDir(factoryYaml("bad").replace("model: p/m }\n      rev", "model: nope }\n      rev"));

  const { code, stdout, stderr } = await startDaemon(home, [file]).exited;

  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(new RegExp(`^foundry daemon: ${file}:\\d+:\\d+: rooms\\.eng\\.stations\\.dev\\.model: .*provider/model.*\\n$`));
  expect(existsSync(home)).toBe(false);
  expect(existsSync(join(dirname(file), "knowledge"))).toBe(false);
});

test("a valid start records the run and its load and creates the empty knowledge layout; the hash follows the resolved config", async () => {
  const home = tempRoot();
  const yaml = factoryYaml("alpha");
  const fixed = "      dev: { isolation: worktree, model: p/m }";
  expect(yaml).toContain(fixed);
  const file = factoryDir(yaml.replace(fixed, "      dev: { isolation: worktree, model: \"${FOU52_DEV_MODEL}\" }"));
  const knowledge = join(dirname(file), "knowledge");

  // The loaded factory takes tickets through the real daemon's management API.
  await runOnce(home, [file], { FOU52_DEV_MODEL: "p/m" }, async () => {
    const spec = join(dirname(file), "spec.md");
    writeFileSync(spec, "# First ticket\n");
    const submitted = await foundry(["ticket", "submit", spec, "--home", home], home);
    expect(submitted).toEqual({ code: 0, stderr: "" });
    // The real daemon lists the factory from the load it recorded for this run.
    const listed = await runFactoryList({ json: true, home, env: { FOUNDRY_HOME: join(home, "not-this-one") } });
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, result: { factories: [{ factoryId: "alpha", state: "running" }] } });
  });
  // Only a comment and blank lines change: the validated configuration, so its hash, is the same.
  appendFileSync(file, "\n# a comment only\n\n");
  await runOnce(home, [file], { FOU52_DEV_MODEL: "p/m" });
  // Only the model variable changes: the resolved configuration, so its hash, differs.
  await runOnce(home, [file], { FOU52_DEV_MODEL: "p/other" });

  const state = await readState(home);
  expect(state.runs).toHaveLength(3);
  expect(state.runs.map((r) => r.version)).toEqual([daemonVersion, daemonVersion, daemonVersion]);
  expect(state.loads.map((l) => [l.run_id, l.factory_id, l.knowledge_root])).toEqual(
    state.runs.map((r) => [r.id, "alpha", knowledge]),
  );
  const [first, second, third] = state.loads;
  expect(first!.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(second!.config_hash).toBe(first!.config_hash);
  expect(third!.config_hash).not.toBe(first!.config_hash);
  // The ticket submitted in the first run carries that run's recorded configuration load.
  expect(state.transitions).toEqual([{ factory_id: "alpha", ticket_number: 1, config_load: String(first!.id) }]);
  expect(JSON.parse(third!.config)).toMatchObject({ stations: [{ address: "eng.dev", model: "p/other" }, { address: "eng.rev" }] });
  expect(JSON.parse(first!.config)).toMatchObject({ config: { name: "alpha" }, stations: [{ address: "eng.dev" }, { address: "eng.rev" }] });
  expect(state.history).toEqual(
    state.runs.flatMap((r, i) => [
      { factory_id: "", kind: "run.started", subject: r.id },
      { factory_id: "alpha", kind: "factory.config_loaded", subject: String(state.loads[i]!.id) },
      ...(i === 0 ? [{ factory_id: "alpha", kind: "ticket.submitted", subject: "1" }] : []),
    ]),
  );

  // Flat layout (PRD §5.4.3): the root, then one directory per room and per station, all empty.
  expect(readdirSync(knowledge).sort()).toEqual(["dev", "eng", "rev"]);
  for (const name of ["dev", "eng", "rev"]) expect(readdirSync(join(knowledge, name))).toEqual([]);
});
