// Integration tier: the claim is about real Git and the filesystem — a dedicated clone created once
// under the state root, reused without contacting the source, refused when not Foundry's, and the
// source left unchanged — so it runs real Git against a local bare repository in a temp dir. One
// row starts the built daemon and runs the built CLI to prove the start and `factory path` wiring.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect, Predicate, Schema } from "effect";
import { runEvents } from "@foundry/cli";
import { clearCloneStaging, CLONE_MARKER_FILE_NAME, DATABASE_FILE_NAME, enqueueOperation, ensureFactoryClone, factoryClonePath, FactoryCloneError, loadFactoryFiles, openStore } from "@foundry/daemon";
import type { LoadedFactory } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";

const isNumber = Schema.is(Schema.Number);

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");
const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

const roots: Array<string> = [];
const children: Array<ChildProcess> = [];

afterEach(() => {
  for (const child of children.splice(0)) {if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}}

  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });}
});

const factoryYaml = (name: string, source: string): string => `version: 1
name: ${name}
repository:
  source: ${source}
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

interface Fixture {
  readonly dir: string;
  readonly home: string;
  /** The bare source repository. */
  readonly source: string;
  readonly yamlFile: string;
  readonly load: (name?: string) => LoadedFactory;
}

/** A temp dir holding a bare source repository with one commit on main, and a factory YAML naming it. */
const fixture = (name = "alpha", home?: string): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-clone-"));
  roots.push(dir);
  makeGitSource(join(dir, "seed"));
  git(dir, ["clone", "--quiet", "--bare", "seed", "source.git"]);
  const source = join(dir, "source.git");
  const yamlFile = join(dir, "factory.yaml");
  writeFileSync(yamlFile, factoryYaml(name, "./source.git"));

  const load = (factoryName = name): LoadedFactory => {
    writeFileSync(yamlFile, factoryYaml(factoryName, "./source.git"));
    const loaded = loadFactoryFiles([yamlFile], { env: {} });

    if (!Predicate.isTagged(loaded, "Loaded")) {throw new Error(loaded.message);}

    return loaded.factories[0]!;
  };

  return { dir, home: home ?? join(dir, "home"), source, yamlFile, load };
};

/** Adds a commit to the source's main, through the seed working copy. */
const advanceSource = (f: Fixture): string => {
  const seed = join(f.dir, "seed");
  writeFileSync(join(seed, "later.md"), "later\n");
  git(seed, ["add", "later.md"]);
  git(seed, ["commit", "--quiet", "--no-verify", "-m", "later"]);
  git(seed, ["push", "--quiet", f.source, "main"]);

  return git(seed, ["rev-parse", "HEAD"]);
};

/** Every ref and the file list of a bare repository: what "unchanged" means for the source. */
const snapshot = (repo: string) => ({ refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), files: readdirSync(repo).sort() });

const options = (home: string) => ({ stateRoot: home, env: isolatedGitEnv() });

/** The clone has not talked to its source since it was made: no fetch record, origin/main where it was. */
const expectNotFetched = (clone: string, first: string): void => {
  expect(existsSync(join(clone, ".git", "FETCH_HEAD"))).toBe(false);
  expect(git(clone, ["rev-parse", "origin/main"])).toBe(first);
  expect(git(clone, ["rev-parse", "HEAD"])).toBe(first);
};

test("first start clones the source under the state root and marks it; a later start reuses it without contacting the source", async () => {
  const f = fixture();
  const before = snapshot(f.source);
  const first = git(f.source, ["rev-parse", "main"]);

  const factory = f.load();
  const created = await ensureFactoryClone(factory, options(f.home));

  expect(created).toEqual({
    factory: "alpha",
    path: join(f.home, "clones", "alpha"),
    created: true,
    source: f.source,
    configuredSource: f.source,
  });
  expect(created.path).toBe(factoryClonePath(f.home, "alpha"));
  expect(git(created.path, ["rev-parse", "HEAD"])).toBe(first);
  expect(git(created.path, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  expect(JSON.parse(readFileSync(join(created.path, ".git", CLONE_MARKER_FILE_NAME), "utf8"))).toMatchObject({
    factory: "alpha",
    source: f.source,
  });
  // No staging directory is left beside the clone.
  expect(readdirSync(join(f.home, "clones"))).toEqual(["alpha"]);
  // The marker is only in the clone's Git directory, not a tracked or untracked file.
  expect(git(created.path, ["status", "--porcelain"])).toBe("");
  expect(snapshot(f.source)).toEqual(before);

  // The source moves on while still reachable: reuse does not fetch it.
  advanceSource(f);
  expect(await ensureFactoryClone(factory, options(f.home))).toEqual({ ...created, created: false });
  expectNotFetched(created.path, first);
  // Then it disappears: reuse does not need it. (Daemon start validates that a local source
  // exists, so the factory is loaded before it goes.)
  renameSync(f.source, `${f.source}.away`);
  expect(await ensureFactoryClone(factory, options(f.home))).toEqual({ ...created, created: false });
  expectNotFetched(created.path, first);
});

test("an unmarked directory or another factory's clone at the clone path is refused and left untouched", async () => {
  const f = fixture();
  const path = factoryClonePath(f.home, "alpha");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "operator-file"), "mine\n");

  await expect(ensureFactoryClone(f.load(), options(f.home))).rejects.toThrow(FactoryCloneError);
  expect(readdirSync(path)).toEqual(["operator-file"]);

  // Another factory's marked clone, moved into alpha's place.
  rmSync(path, { recursive: true });
  const beta = await ensureFactoryClone(f.load("beta"), options(f.home));
  renameSync(beta.path, path);
  await expect(ensureFactoryClone(f.load("alpha"), options(f.home))).rejects.toThrow(/clone of factory "beta"/);
  expect(JSON.parse(readFileSync(join(path, ".git", CLONE_MARKER_FILE_NAME), "utf8"))).toMatchObject({ factory: "beta" });
});

test("a failed clone is never adopted: nothing is left at the clone path or in staging", async () => {
  const f = fixture();
  const factory = f.load();
  const missingBranch = { ...factory, config: { ...factory.config, repository: { ...factory.config.repository, default_branch: "absent" } } };

  await expect(ensureFactoryClone(missingBranch, options(f.home))).rejects.toMatchObject({
    reason: "clone_failed",
    message: expect.stringMatching(/cannot clone .* \(branch absent\)/),
  });
  expect(readdirSync(join(f.home, "clones"))).toEqual([]);
  // The next attempt, with a valid branch, creates it.
  expect((await ensureFactoryClone(factory, options(f.home))).created).toBe(true);
});

test("staging left by a daemon that died mid-clone is removed; clones are not", async () => {
  const f = fixture();
  const clone = await ensureFactoryClone(f.load(), options(f.home));
  const leftover = join(f.home, "clones", ".alpha.creating-abc123");
  mkdirSync(join(leftover, "clone", ".git"), { recursive: true });

  expect(clearCloneStaging(f.home)).toEqual([leftover]);
  expect(readdirSync(join(f.home, "clones"))).toEqual(["alpha"]);
  expect(existsSync(join(clone.path, ".git", CLONE_MARKER_FILE_NAME))).toBe(true);
});

const foundry = (args: ReadonlyArray<string>, home: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((done) => {
    execFile(
      process.execPath,
      [cliMain, ...args, "--home", home],
      { env: { ...process.env, FOUNDRY_HOME: join(home, "not-this-one") }, timeout: 20_000 },
      (error, stdout, stderr) =>
        done({ code: error === null ? 0 : isNumber(error.code) ? error.code : null, stdout, stderr }),
    );
  });

const startDaemon = (home: string, ...files: Array<string>): Promise<ChildProcess> => {
  const child = spawn(process.execPath, [daemonMain, "--home", home, ...files], {
    env: { ...isolatedGitEnv(), FOUNDRY_HOME: join(home, "not-this-one") },
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

  return new Promise((resolve, reject) => {
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();

      if (stdout.includes("management API on")) {resolve(child);}
    });
    child.on("exit", (code) => reject(new Error(`daemon exited ${code} before serving: ${stderr}`)));
  });
};

const stop = async (child: ChildProcess): Promise<number | null> => {
  const exited = new Promise<number | null>((done) => { child.on("exit", done); });
  child.kill("SIGTERM");

  return exited;
};

test("daemon start creates the clone and foundry factory path prints it; a restart does not fetch, an explicit sync does", async () => {
  const f = fixture();
  const first = git(f.source, ["rev-parse", "main"]);
  const path = factoryClonePath(f.home, "alpha");

  let daemon = await startDaemon(f.home, f.yamlFile);
  expect(await foundry(["factory", "path", "alpha"], f.home)).toEqual({ code: 0, stdout: `${path}\n`, stderr: "" });
  const json = await foundry(["factory", "path", "alpha", "--json"], f.home);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ ok: true, result: { factory: "alpha", path } });
  const unknown = await foundry(["factory", "path", "nope"], f.home);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('no loaded factory named "nope"');
  expect(await stop(daemon)).toBe(0);

  const fetched = advanceSource(f);
  const sourceRefs = snapshot(f.source).refs;
  daemon = await startDaemon(f.home, f.yamlFile);
  expect(await foundry(["factory", "path", "alpha"], f.home)).toMatchObject({ code: 0, stdout: `${path}\n` });
  // The source is still there and has moved on, yet the restart never fetched it.
  expectNotFetched(path, first);
  expect(existsSync(join(f.source, CLONE_MARKER_FILE_NAME))).toBe(false);

  // Only the operator's explicit sync contacts the source, and it advances the clone.
  const synced = await foundry(["factory", "sync", "alpha", "--wait", "--json"], f.home);
  expect(synced.code).toBe(0);
  expect(JSON.parse(synced.stdout)).toMatchObject({
    ok: true,
    result: { factory: "alpha", operation: { status: "complete", result: { previousHead: first, fetchedHead: fetched, head: fetched } } },
  });
  expect(git(path, ["rev-parse", "main"])).toBe(fetched);
  expect((await foundry(["factory", "sync", "nope"], f.home)).code).toBe(1);
  expect(await stop(daemon)).toBe(0);
  // P0 never pushes: the source's refs are as the operator left them.
  expect(snapshot(f.source).refs).toBe(sourceRefs);
});

test("restart completes a previously queued sync without another operator request", async () => {
  const f = fixture();
  const path = factoryClonePath(f.home, "alpha");
  expect(await stop(await startDaemon(f.home, f.yamlFile))).toBe(0);
  const previous = git(path, ["rev-parse", "main"]);
  const fetched = advanceSource(f);

  // Model a stop after the operator's request committed, but before the queue admitted it.
  const queued = await Effect.runPromise(Effect.scoped(Effect.flatMap(
    openStore({ filename: join(f.home, DATABASE_FILE_NAME) }),
    (store) => enqueueOperation(store, { factoryId: "alpha", kind: "sync", intent: { defaultBranch: "main" } }),
  )));

  const daemon = await startDaemon(f.home, f.yamlFile);
  const done = new AbortController();
  let terminal: unknown;
  await runEvents({
    home: f.home, env: {}, factory: "alpha", ticket: undefined, since: undefined, follow: true, json: true,
    signal: AbortSignal.any([done.signal, AbortSignal.timeout(2000)]),
    write: (line) => {
      const event = JSON.parse(line);

      if (event.subject === String(queued.id) && ["operation.complete", "operation.failed"].includes(event.kind)) {
        terminal = event;
        done.abort();
      }
    },
  });
  expect(terminal).toMatchObject({ kind: "operation.complete", detail: { result: { previousHead: previous, fetchedHead: fetched } } });
  expect(git(path, ["rev-parse", "main"])).toBe(fetched);
  expect(await stop(daemon)).toBe(0);
});

test("a factory whose clone path is not Foundry's is refused alone; the daemon serves the other", async () => {
  const alpha = fixture("alpha");
  const beta = fixture("beta", alpha.home);
  const betaPath = factoryClonePath(alpha.home, "beta");
  mkdirSync(betaPath, { recursive: true });
  writeFileSync(join(betaPath, "operator-file"), "mine\n");

  const daemon = await startDaemon(alpha.home, alpha.yamlFile, beta.yamlFile);
  expect(await foundry(["factory", "path", "alpha"], alpha.home)).toMatchObject({
    code: 0,
    stdout: `${factoryClonePath(alpha.home, "alpha")}\n`,
  });
  expect((await foundry(["factory", "path", "beta"], alpha.home)).code).toBe(1);
  expect(await stop(daemon)).toBe(0);

  expect(readdirSync(betaPath)).toEqual(["operator-file"]);

  const rows = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(openStore({ filename: join(alpha.home, DATABASE_FILE_NAME) }), (store) =>
        store.read<{ factory_id: string; kind: string; subject: string; detail: string }>(
          `SELECT factory_id, kind, subject, detail FROM history ORDER BY sequence`,
        ),
      ),
    ),
  );

  // The run and both configuration loads are recorded; one refusal names beta and why.
  expect(rows.map((r) => [r.factory_id, r.kind])).toEqual([
    ["", "run.started"],
    ["alpha", "factory.config_loaded"],
    ["beta", "factory.config_loaded"],
    ["beta", "factory.start_refused"],
  ]);
  expect(JSON.parse(rows[3]!.detail)).toMatchObject({ reason: "clone_refused", clonePath: betaPath, configLoad: expect.any(String) });
});
