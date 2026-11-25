/**
 * Syncing a factory's clone from its source on the operator's request (PRD §9.1, §9.4): `foundry
 * factory sync` queues a sync operation on the factory's integration and sync queue, and the
 * daemon runs the queue one operation at a time. The daemon never contacts the source otherwise.
 *
 * A sync fetches the default branch from the clone's `origin` (the source it was cloned from) and
 * merges it into the clone's default branch, fast-forward when possible. Before it merges it records
 * the head it started from and the commit it fetched in the operation's intent, so recovery can
 * tell what landed; its result records the previous, fetched and resulting heads. P0 never pushes.
 *
 * Out of scope here: reconciling a sync interrupted by a crash, and restoring the recorded head with
 * a sync-conflict hold after a conflict (PRD §10.2). A conflicting merge is aborted and the sync is
 * marked failed.
 */
import { Data, Effect } from "effect";
import { messageOf } from "@foundry/protocol/errors";
import { runCloneGit } from "./factory-clone.js";
import { enqueueOperation, extendOperationIntent, getOperation, runOperation, startNextOperation } from "./operations.js";
import type { Operation, OperationDetail, OperationOutcome } from "./operations.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Store, StoreError } from "./store.js";

/** What the daemon knows about one loaded factory's clone. */
export interface SyncTarget {
  readonly clonePath: string;
  readonly defaultBranch: string;
}

/** The identity of a merge commit the daemon makes in its own clone. */
const MERGE_IDENTITY = ["-c", "user.name=Foundry", "-c", "user.email=foundry@foundry.invalid"] as const;

/**
 * Fast-forward when possible and never sign, whatever the operator's `merge.ff` or `commit.gpgSign`
 * say (PRD §9.1): their Git config must not force a merge commit, refuse one, or wait on pinentry.
 */
const MERGE_POLICY = ["--ff", "--no-gpg-sign"] as const;

/** No hooks: the operator's configured hooks are not Foundry's. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

const isAncestor = async (clone: string, ancestor: string, of: string, env: NodeJS.ProcessEnv): Promise<boolean> => {
  try {
    await runCloneGit(["merge-base", "--is-ancestor", ancestor, of], env, clone);

    return true;
  } catch {
    return false;
  }
};

/** A Git step of a sync failed; carries the failed result to record. Never leaves this module. */
class SyncStepFailed extends Data.TaggedError("SyncStepFailed")<{ readonly result: OperationDetail }> {}

/**
 * Fetches the source's default branch into the clone and merges it into the clone's default
 * branch. Git failures become a failed outcome; only store errors fail the effect.
 */
export const syncClone = (
  store: Store,
  operation: Operation,
  target: SyncTarget,
  env: NodeJS.ProcessEnv,
): Effect.Effect<OperationOutcome, StoreError> => {
  const clone = target.clonePath;
  const branch = target.defaultBranch;

  const git = (args: ReadonlyArray<string>, failed: (reason: string) => OperationDetail) =>
    Effect.tryPromise({
      try: () => runCloneGit(args, env, clone),
      catch: (cause) => new SyncStepFailed({ result: failed(messageOf(cause)) }),
    });

  const tracking = `refs/remotes/origin/${branch}`;

  return Effect.gen(function* () {
    const previousHead = yield* git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], (reason) => ({
      reason: `cannot read ${branch}: ${reason}`,
    }));

    // Git merges into the current checkout. Align Foundry's dedicated checkout with its configured
    // default branch without moving the branch that was checked out before the sync.
    yield* git([...NO_HOOKS, "switch", "--quiet", "--no-guess", "--no-recurse-submodules", "--", branch], (reason) => ({
      previousHead,
      reason: `cannot switch the clone to ${branch}: ${reason}`,
    }));

    const fetchFailed = (reason: string) => ({ previousHead, reason: `fetch failed: ${reason}` });

    yield* git([...NO_HOOKS, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:${tracking}`], fetchFailed);

    const fetchedHead = yield* git(["rev-parse", "--verify", `${tracking}^{commit}`], fetchFailed);

    // Committed before the merge changes anything, so recovery knows both heads.
    yield* extendOperationIntent(store, operation.id, { recordedHead: previousHead, fetchedHead });

    const fastForward = yield* Effect.promise(() => isAncestor(clone, previousHead, fetchedHead, env));

    yield* git(
      [...NO_HOOKS, ...MERGE_IDENTITY, "merge", ...MERGE_POLICY, "--quiet", "--no-edit", "-m", `Sync ${branch} from source`, fetchedHead],
      (reason) => ({ previousHead, fetchedHead, reason: `merge failed: ${reason}` }),
    ).pipe(
      // Leave no half-finished merge behind. Restoring the recorded head with a sync-conflict hold is FOU-61.
      Effect.tapError(() => Effect.ignore(git(["merge", "--abort"], () => ({})))),
    );

    const head = yield* Effect.orElseSucceed(
      git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], () => ({})),
      () => fetchedHead,
    );

    return { status: "complete", result: { previousHead, fetchedHead, head, fastForward } } satisfies OperationOutcome;
  }).pipe(
    Effect.catchTag("SyncStepFailed", (failure) =>
      Effect.succeed({ status: "failed", result: failure.result } satisfies OperationOutcome),
    ),
  );
};

export type SyncRequestReply =
  | { readonly found: false }
  | { readonly found: true; readonly operation: Operation };

/** Queues and runs operator-requested syncs (`foundry factory sync`). */
export interface FactorySyncer {
  /** Drain previously accepted requests without creating a new operation. */
  readonly resumeQueued: (factory: string) => Promise<void>;
  /**
   * Queues a sync of `factory`'s clone and starts the queue. Answers with the queued operation once
   * it is committed, or, with `wait`, once the queue has run it. `found: false` for a factory that
   * is not loaded.
   */
  readonly request: (factory: string, wait: boolean) => Promise<SyncRequestReply>;
}

export interface FactorySyncerOptions {
  readonly store: Store;
  /** The clone of each started factory; `undefined` for one that is not loaded. */
  readonly target: (factory: string) => SyncTarget | undefined;
  /** Git's environment. Default: the process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Told about a queue run that failed outside any operation's result (a store error). */
  readonly onError?: (factory: string, cause: unknown) => void;
}

/**
 * Runs a factory's queue until nothing more is admitted. Only syncs run here: nothing queues an
 * integration yet, and one admitted without a runner dies, leaving the queue closed for recovery.
 */
const drainQueue = (store: Store, factory: string, target: SyncTarget, env: NodeJS.ProcessEnv): Effect.Effect<void, StoreError> =>
  Effect.gen(function* () {
    for (;;) {
      const next = yield* startNextOperation(store, factory);

      if (next === undefined) {return;}

      if (next.kind !== "sync") {return yield* Effect.die(new Error(`no runner for ${next.kind} operation ${next.id}`));}

      yield* runOperation(store, next, (operation) => syncClone(store, operation, target, env));
    }
  });

export const createFactorySyncer = (options: FactorySyncerOptions): FactorySyncer => {
  const env = options.env ?? process.env;
  // One queue run at a time per factory; a later request waits behind the earlier run.
  const runs = new Map<string, Promise<void>>();

  const scheduleDrain = (factory: string, target: SyncTarget): Promise<void> => {
    const run = (runs.get(factory) ?? Promise.resolve()).then(() =>
      Effect.runPromise(drainQueue(options.store, factory, target, env)).catch((cause: unknown) => options.onError?.(factory, cause)),
    );

    runs.set(factory, run);

    return run;
  };

  return {
    resumeQueued: async (factory) => {
      const target = options.target(factory);

      if (target !== undefined) {await scheduleDrain(factory, target);}
    },
    request: async (factory, wait) => {
      const target = options.target(factory);

      if (target === undefined) {return { found: false };}

      const queued = await Effect.runPromise(
        enqueueOperation(options.store, { factoryId: factory, kind: "sync", intent: { defaultBranch: target.defaultBranch } }),
      );

      const run = scheduleDrain(factory, target);

      if (!wait) {return { found: true, operation: queued };}

      await run;
      const current = await Effect.runPromise(getOperation(options.store, queued.id));

      return { found: true, operation: current ?? queued };
    },
  };
};
