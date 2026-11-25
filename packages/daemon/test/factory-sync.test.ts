// Integration tier: the claims are about real Git and what the store commits — a sync advances the
// clone, records the previous and fetched heads, never pushes, and leaves no half-finished merge —
// so each test runs real Git against a local bare source in a temp dir with a disposable database.
// The daemon and CLI wiring is proved once in factory-clone.test.ts.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { createFactorySyncer, getHold, listOpenHolds, listOperations, openStore, raiseHold } from "@foundry/daemon";
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

const syncer = (store: Store, f: Fixture, defaultBranch = "main") =>
  createFactorySyncer({ store, target: (name) => (name === "alpha" ? { clonePath: f.clone, defaultBranch } : undefined), env: isolatedGitEnv() });

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

test("sync advances the configured default branch without moving the previously checked-out branch", async () => {
  const f = fixture();
  const previous = git(f.clone, ["rev-parse", "HEAD"]);
  git(f.clone, ["branch", "next"]);
  const otherHead = commit(f.clone, "main-only.md", "main only\n");
  const fetched = commit(f.seed, "next-only.md", "next only\n");
  git(f.seed, ["push", "--quiet", f.source, "HEAD:refs/heads/next"]);
  const sourceBefore = refsOf(f.source);

  const reply = await withStore(f.dir, (store) => syncer(store, f, "next").request("alpha", true));

  expect(reply).toMatchObject({ operation: { status: "complete", result: { previousHead: previous, fetchedHead: fetched, head: fetched, fastForward: true } } });
  expect(git(f.clone, ["rev-parse", "next", "main"]).split("\n")).toEqual([fetched, otherHead]);
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

test("conflicts restore the head, refresh one factory hold, keep the queue open and clear only on success", async () => {
  const f = fixture();
  const previous = commit(f.clone, "README.md", "clone side\n");
  const fetched = commit(f.seed, "README.md", "source side\n");
  pushSeed(f);

  const reply = await withStore(f.dir, async (store) => {
    const s = syncer(store, f);
    const first = await s.request("alpha", true);
    const holds = await Effect.runPromise(listOpenHolds(store));
    expect(holds).toMatchObject([{
      factoryId: "alpha", subject: "alpha", kind: "sync_conflict", state: "open",
      evidence: { recordedHead: previous, fetchedHead: fetched, conflictingFiles: ["README.md"] },
    }]);
    expect(existsSync(join(f.clone, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(f.clone, ["rev-parse", "HEAD"])).toBe(previous);
    expect(git(f.clone, ["status", "--porcelain"])).toBe("");

    const refreshedHead = commit(f.seed, "README.md", "another source side\n");
    pushSeed(f);
    expect(await s.request("alpha", true)).toMatchObject({ operation: { status: "failed" } });
    expect(await Effect.runPromise(listOpenHolds(store))).toMatchObject([{
      id: holds[0]?.id, evidence: { recordedHead: previous, fetchedHead: refreshedHead, conflictingFiles: ["README.md"] },
    }]);
    expect(git(f.clone, ["rev-parse", "HEAD"])).toBe(previous);

    // A non-conflict failure must not clear the unresolved conflict.
    git(f.clone, ["remote", "set-url", "origin", join(f.dir, "missing.git")]);
    expect(await s.request("alpha", true)).toMatchObject({ operation: { status: "failed" } });
    expect(await Effect.runPromise(listOpenHolds(store))).toHaveLength(1);
    git(f.clone, ["remote", "set-url", "origin", f.source]);

    // The operator resolves in their own working repository, never in Foundry's clone.
    git(f.seed, ["fetch", "--quiet", f.clone, "main"]);
    git(f.seed, ["merge", "--quiet", "--no-edit", "-s", "ours", "FETCH_HEAD"]);
    pushSeed(f);

    const unrelated = await Effect.runPromise(raiseHold(store, {
      factoryId: "beta", subject: "beta", kind: "sync_conflict", evidence: { recordedHead: "unrelated" },
    }));

    expect(await s.request("alpha", true)).toMatchObject({ operation: { status: "complete" } });
    expect(await Effect.runPromise(getHold(store, holds[0]!.id))).toMatchObject({ state: "cleared" });
    expect(await Effect.runPromise(listOpenHolds(store))).toEqual([unrelated.hold]);
    expect((await Effect.runPromise(listOperations(store, "alpha"))).map((op) => op.status)).toEqual(["failed", "failed", "failed", "complete"]);

    return first;
  });

  expect(reply).toMatchObject({
    found: true,
    operation: { status: "failed", intent: { recordedHead: previous, fetchedHead: fetched }, result: { previousHead: previous, fetchedHead: fetched, conflictingFiles: ["README.md"] } },
  });
  expect(existsSync(join(f.clone, ".git", "MERGE_HEAD"))).toBe(false);
  expect(git(f.clone, ["status", "--porcelain"])).toBe("");
});

test("remembered rerere resolutions cannot hide sync conflicts or leave a merge in progress", async () => {
  const f = fixture();
  const previous = commit(f.clone, "README.md", "clone side\n");
  const fetched = commit(f.seed, "README.md", "source side\n");
  pushSeed(f);
  git(f.clone, ["config", "rerere.enabled", "true"]);
  git(f.clone, ["config", "rerere.autoupdate", "true"]);
  git(f.clone, ["fetch", "--quiet", "origin", "main"]);

  // Teach Git a resolution, then return to the original divergent head. A subsequent normal
  // merge exits unsuccessfully but autoupdate would leave no unmerged index entries to inspect.
  expect(() => git(f.clone, ["merge", "--no-edit", fetched])).toThrow();
  writeFileSync(join(f.clone, "README.md"), "remembered resolution\n");
  git(f.clone, ["rerere"]);
  git(f.clone, ["merge", "--abort"]);

  const { reply, holds } = await withStore(f.dir, async (store) => ({
    reply: await syncer(store, f).request("alpha", true),
    holds: await Effect.runPromise(listOpenHolds(store)),
  }));

  expect(reply).toMatchObject({ operation: { status: "failed", result: { conflictingFiles: ["README.md"] } } });
  expect(holds).toMatchObject([{
    kind: "sync_conflict", evidence: { recordedHead: previous, fetchedHead: fetched, conflictingFiles: ["README.md"] },
  }]);
  expect(git(f.clone, ["rev-parse", "HEAD"])).toBe(previous);
  expect(git(f.clone, ["status", "--porcelain"])).toBe("");
  expect(existsSync(join(f.clone, ".git", "MERGE_HEAD"))).toBe(false);
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
