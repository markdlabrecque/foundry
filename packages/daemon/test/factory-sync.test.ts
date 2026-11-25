// Integration tier: the claims are about real Git and what the store commits — a sync advances the
// clone, records the previous and fetched heads, never pushes, and leaves no half-finished merge —
// so each test runs real Git against a local bare source in a temp dir with a disposable database.
// The daemon and CLI wiring is proved once in factory-clone.test.ts.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { createFactorySyncer, listOperations, openStore } from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { git, isolatedGitEnv, makeGitSource } from "@foundry/testkit";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });}
});

interface Fixture {
  readonly dir: string;
  readonly seed: string;
  readonly source: string;
  readonly clone: string;
}

/** A bare source with one commit on main, fed from a seed working copy, and a clone of it. */
const fixture = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-sync-"));
  roots.push(dir);
  const seed = join(dir, "seed");
  makeGitSource(seed);
  git(dir, ["clone", "--quiet", "--bare", "seed", "source.git"]);
  git(dir, ["clone", "--quiet", "source.git", "clone"]);

  return { dir, seed, source: join(dir, "source.git"), clone: join(dir, "clone") };
};

/** Commits `file` with `content` in `repo`; returns the new head. */
const commit = (repo: string, file: string, content: string): string => {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", file]);

  return git(repo, ["rev-parse", "HEAD"]);
};

const pushSeed = (f: Fixture): void => {
  git(f.seed, ["push", "--quiet", f.source, "main"]);
};

const refsOf = (repo: string): string => git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);

const withStore = <A>(dir: string, use: (store: Store) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(openStore({ filename: join(dir, "foundry.db") }), (store) => Effect.promise(() => use(store)))),
  );

const syncer = (store: Store, f: Fixture) =>
  createFactorySyncer({ store, target: (name) => (name === "alpha" ? { clonePath: f.clone, defaultBranch: "main" } : undefined), env: isolatedGitEnv() });

test("an explicit sync fast-forwards the clone, records the previous and fetched heads, and never pushes", async () => {
  const f = fixture();
  const previous = git(f.clone, ["rev-parse", "HEAD"]);
  const fetched = commit(f.seed, "later.md", "later\n");
  pushSeed(f);
  const sourceBefore = refsOf(f.source);

  const { reply, operations } = await withStore(f.dir, async (store) => {
    const answered = await syncer(store, f).request("alpha", true);

    return { reply: answered, operations: await Effect.runPromise(listOperations(store, "alpha")) };
  });

  expect(reply).toMatchObject({ found: true, operation: { kind: "sync", status: "complete" } });
  expect(operations).toMatchObject([
    {
      kind: "sync",
      status: "complete",
      intent: { defaultBranch: "main", recordedHead: previous, fetchedHead: fetched },
      result: { previousHead: previous, fetchedHead: fetched, head: fetched, fastForward: true },
    },
  ]);
  expect(git(f.clone, ["rev-parse", "main"])).toBe(fetched);
  expect(git(f.clone, ["status", "--porcelain"])).toBe("");
  expect(refsOf(f.source)).toBe(sourceBefore);
});

test("a clone ahead of its source gets a merge commit whose parents are the previous and fetched heads", async () => {
  const f = fixture();
  const previous = commit(f.clone, "local.md", "local\n");
  const fetched = commit(f.seed, "later.md", "later\n");
  pushSeed(f);

  const reply = await withStore(f.dir, (store) => syncer(store, f).request("alpha", true));

  expect(reply).toMatchObject({ found: true, operation: { status: "complete", result: { previousHead: previous, fetchedHead: fetched, fastForward: false } } });
  expect(git(f.clone, ["rev-parse", "main^1", "main^2"]).split("\n")).toEqual([previous, fetched]);
});

test("the clone's merge.ff=false and commit.gpgSign=true neither prevent a fast-forward nor block a merge commit", async () => {
  const f = fixture();
  git(f.clone, ["config", "merge.ff", "false"]);
  const fastForwarded = commit(f.seed, "later.md", "later\n");
  pushSeed(f);

  const first = await withStore(f.dir, (store) => syncer(store, f).request("alpha", true));

  expect(first).toMatchObject({ operation: { status: "complete", result: { head: fastForwarded, fastForward: true } } });
  expect(git(f.clone, ["rev-parse", "main"])).toBe(fastForwarded);

  const local = commit(f.clone, "local.md", "local\n");
  // Set after the local commit, which would otherwise need signing too. The signing program always
  // fails, so an attempted signature fails the sync instead of prompting.
  git(f.clone, ["config", "commit.gpgSign", "true"]);
  git(f.clone, ["config", "gpg.program", "false"]);
  const fetched = commit(f.seed, "again.md", "again\n");
  pushSeed(f);

  const second = await withStore(f.dir, (store) => syncer(store, f).request("alpha", true));

  expect(second).toMatchObject({ operation: { status: "complete", result: { previousHead: local, fetchedHead: fetched, fastForward: false } } });
  expect(git(f.clone, ["rev-parse", "main^1", "main^2"]).split("\n")).toEqual([local, fetched]);
});

test("a conflicting sync fails with both heads recorded and leaves no merge in progress", async () => {
  const f = fixture();
  const previous = commit(f.clone, "README.md", "clone side\n");
  const fetched = commit(f.seed, "README.md", "source side\n");
  pushSeed(f);

  const reply = await withStore(f.dir, (store) => syncer(store, f).request("alpha", true));

  expect(reply).toMatchObject({
    found: true,
    operation: { status: "failed", intent: { recordedHead: previous, fetchedHead: fetched }, result: { previousHead: previous, fetchedHead: fetched } },
  });
  expect(existsSync(join(f.clone, ".git", "MERGE_HEAD"))).toBe(false);
  expect(git(f.clone, ["rev-parse", "main"])).toBe(previous);
});

test("a sync request without wait answers with the queued operation; an unknown factory is not found", async () => {
  const f = fixture();

  const replies = await withStore(f.dir, async (store) => {
    const s = syncer(store, f);

    return { queued: await s.request("alpha", false), unknown: await s.request("nope", false), waited: await s.request("alpha", true) };
  });

  expect(replies.queued).toMatchObject({ found: true, operation: { id: 1, status: "queued" } });
  expect(replies.unknown).toEqual({ found: false });
  // The second request queues behind the first; waiting on it means both have run.
  expect(replies.waited).toMatchObject({ found: true, operation: { id: 2, status: "complete" } });
});
