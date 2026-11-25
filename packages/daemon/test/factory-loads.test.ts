// Integration tier: the claim is about what a real daemon start leaves behind — the exit code and
// message on refusal, the run and configuration-load rows in the state root's database, and the
// knowledge directories on disk — so it runs the built foreground daemon against temp dirs.
// Validation rules themselves are covered by the config unit tests; one invalid case suffices here.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { DATABASE_FILE_NAME, openStore } from "@foundry/daemon";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");

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

const startDaemon = (home: string, files: ReadonlyArray<string>): Run => {
  // FOUNDRY_HOME points elsewhere so the operator's root is never used.
  const child = spawn(process.execPath, [daemonMain, "--home", home, ...files], {
    env: { ...process.env, FOUNDRY_HOME: join(home, "not-this-one") },
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

/** Starts the daemon, waits until it serves, and stops it cleanly. */
const runOnce = async (home: string, files: ReadonlyArray<string>): Promise<void> => {
  const run = startDaemon(home, files);
  await run.serving;
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

test("a valid start records the run and its load, creates the empty knowledge layout, and a restart reloads the same hash", async () => {
  const home = tempRoot();
  const file = factoryDir(factoryYaml("alpha"));
  const knowledge = join(dirname(file), "knowledge");

  await runOnce(home, [file]);
  await runOnce(home, [file]);

  const state = await readState(home);
  expect(state.runs).toHaveLength(2);
  expect(state.runs.every((r) => r.version === "0.0.0")).toBe(true);
  expect(state.loads.map((l) => [l.run_id, l.factory_id, l.knowledge_root])).toEqual(
    state.runs.map((r) => [r.id, "alpha", knowledge]),
  );
  const [first, second] = state.loads;
  expect(first!.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(second!.config_hash).toBe(first!.config_hash);
  expect(JSON.parse(first!.config)).toMatchObject({ config: { name: "alpha" }, stations: [{ address: "eng.dev" }, { address: "eng.rev" }] });
  expect(state.history).toEqual(
    state.runs.flatMap((r, i) => [
      { factory_id: "", kind: "run.started", subject: r.id },
      { factory_id: "alpha", kind: "factory.config_loaded", subject: String(state.loads[i]!.id) },
    ]),
  );

  // Flat layout (PRD §5.4.3): the root, then one directory per room and per station, all empty.
  expect(readdirSync(knowledge).sort()).toEqual(["dev", "eng", "rev"]);
  for (const name of ["dev", "eng", "rev"]) expect(readdirSync(join(knowledge, name))).toEqual([]);
});
