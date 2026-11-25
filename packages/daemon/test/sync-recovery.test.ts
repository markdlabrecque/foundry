// Integration tier: the claims are about what real Git leaves in the clone and what the store
// commits after a crash mid-sync — a landed sync is recognised, a half-finished merge is undone,
// and recovery never fetches — so each test runs real Git against a local bare source in a temp
// dir with a disposable database. The startup wiring in main.ts only calls this per factory.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import {
  createFactorySyncer,
  enqueueOperation,
  extendOperationIntent,
  interruptRunningOperations,
  listOpenHolds,
  listOperationsAwaitingRecovery,
  openStore,
  recoverInterruptedSyncs,
  startNextOperation,
} from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { expectDefined } from "@foundry/protocol/errors";
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

const fixture = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-sync-recovery-"));
  roots.push(dir);
  const seed = join(dir, "seed");
  makeGitSource(seed);
  git(dir, ["clone", "--quiet", "--bare", "seed", "source.git"]);
  git(dir, ["clone", "--quiet", "source.git", "clone"]);

  return { dir, seed, source: join(dir, "source.git"), clone: join(dir, "clone") };
};

const commit = (repo: string, file: string, content: string): string => {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", file]);

  return git(repo, ["rev-parse", "HEAD"]);
};

const pushSeed = (f: Fixture): void => {
  git(f.seed, ["push", "--quiet", f.source, "main"]);
};

const withStore = <A>(dir: string, use: (store: Store) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(openStore({ filename: join(dir, "foundry.db") }), (store) => Effect.promise(() => use(store)))),
  );

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/**
 * Plays a sync up to the point the daemon died: the operation is running with both heads recorded,
 * the clone has fetched, and `crash` leaves the clone however the merge got. Then a restart marks
 * it interrupted, as main.ts does.
 */
const crashMidSync = async (f: Fixture, crash: (fetched: string) => void): Promise<{ previous: string; fetched: string; operationId: number }> => {
  const previous = git(f.clone, ["rev-parse", "main"]);
  git(f.clone, ["fetch", "--quiet", "origin"]);
  const fetched = git(f.clone, ["rev-parse", "refs/remotes/origin/main"]);

  const operationId = await withStore(f.dir, async (store) => {
    await run(enqueueOperation(store, { factoryId: "alpha", kind: "sync", intent: { defaultBranch: "main" } }));
    const started = expectDefined(await run(startNextOperation(store, "alpha")), "the admitted sync");
    await run(extendOperationIntent(store, started.id, { recordedHead: previous, fetchedHead: fetched }));

    return started.id;
  });

  crash(fetched);
  await withStore(f.dir, (store) => run(interruptRunningOperations(store)));

  return { previous, fetched, operationId };
};

const target = (f: Fixture) => ({ clonePath: f.clone, defaultBranch: "main" });

test("a sync whose fetched commit already landed is recorded complete, without fetching, and the queue reopens", async () => {
  const f = fixture();
  commit(f.seed, "later.md", "later\n");
  pushSeed(f);
  const { previous, fetched, operationId } = await crashMidSync(f, (head) => git(f.clone, ["merge", "--quiet", "--ff-only", head]));

  // The source moves on after the crash; recovery must not pick that up.
  commit(f.seed, "after-crash.md", "after crash\n");
  pushSeed(f);

  const seen = await withStore(f.dir, async (store) => ({
    recovered: await run(recoverInterruptedSyncs(store, "alpha", target(f), isolatedGitEnv())),
    awaiting: await run(listOperationsAwaitingRecovery(store, "alpha")),
    holds: await run(listOpenHolds(store)),
  }));

  expect(seen.recovered).toMatchObject([{
    verdict: "complete",
    operation: { id: operationId, status: "complete", result: { previousHead: previous, fetchedHead: fetched, head: fetched } },
  }]);
  expect(seen.awaiting).toEqual([]);
  expect(seen.holds).toEqual([]);
  expect(git(f.clone, ["rev-parse", "main", "refs/remotes/origin/main"]).split("\n")).toEqual([fetched, fetched]);
});

test("a half-finished merge is aborted, the recorded head restored, the sync marked interrupted with a hold, and nothing fetched", async () => {
  const f = fixture();
  commit(f.clone, "README.md", "clone side\n");
  commit(f.seed, "README.md", "source side\n");
  pushSeed(f);

  const { previous, fetched, operationId } = await crashMidSync(f, (head) => {
    expect(() => git(f.clone, ["merge", "--no-edit", head])).toThrow();
  });

  expect(existsSync(join(f.clone, ".git", "MERGE_HEAD"))).toBe(true);

  commit(f.seed, "after-crash.md", "after crash\n");
  pushSeed(f);

  const seen = await withStore(f.dir, async (store) => {
    const recovered = await run(recoverInterruptedSyncs(store, "alpha", target(f), isolatedGitEnv()));
    const holds = await run(listOpenHolds(store));
    // The queue is open again: a new sync is admitted.
    await run(enqueueOperation(store, { factoryId: "alpha", kind: "sync", intent: { defaultBranch: "main" } }));
    const next = await run(startNextOperation(store, "alpha"));

    return { recovered, holds, next };
  });

  expect(seen.recovered).toMatchObject([{
    verdict: "interrupted",
    operation: { id: operationId, status: "interrupted", result: { previousHead: previous, fetchedHead: fetched, head: previous, abortedMerge: true } },
  }]);
  expect(seen.holds).toMatchObject([{
    factoryId: "alpha", subject: "alpha", kind: "interrupted_sync", state: "open",
    evidence: { recordedHead: previous, fetchedHead: fetched },
  }]);
  expect(seen.next).toMatchObject({ kind: "sync", status: "running" });
  expect(existsSync(join(f.clone, ".git", "MERGE_HEAD"))).toBe(false);
  expect(git(f.clone, ["rev-parse", "main"])).toBe(previous);
  expect(git(f.clone, ["status", "--porcelain"])).toBe("");
  expect(git(f.clone, ["rev-parse", "refs/remotes/origin/main"])).toBe(fetched);
});

test("running the sync again resolves the interrupted-sync hold", async () => {
  const f = fixture();
  commit(f.seed, "later.md", "later\n");
  pushSeed(f);
  // Crashed after fetching, before merging.
  const { previous } = await crashMidSync(f, () => {});

  const seen = await withStore(f.dir, async (store) => {
    await run(recoverInterruptedSyncs(store, "alpha", target(f), isolatedGitEnv()));
    const before = await run(listOpenHolds(store));
    const syncer = createFactorySyncer({ store, target: (name) => (name === "alpha" ? target(f) : undefined), env: isolatedGitEnv() });
    const reply = await syncer.request("alpha", true);

    return { before, reply, after: await run(listOpenHolds(store)) };
  });

  expect(seen.before).toMatchObject([{ kind: "interrupted_sync", evidence: { recordedHead: previous } }]);
  expect(seen.reply).toMatchObject({ operation: { status: "complete" } });
  expect(seen.after).toEqual([]);
});
