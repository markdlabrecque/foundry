/**
 * Startup recovery of an interrupted first-worktree `after_create` (PRD §10.2, step 3): it reruns
 * from the start in the same worktree, through the shared hook runner, so the rerun keeps the
 * normal log, hook-failure hold and pause on failure.
 *
 * The rerun is a new hook operation, like an operator retry: the interrupted one keeps status
 * `interrupted` and gets a recovery result naming its rerun, in the same change that records the
 * rerun as running. Assignment reads the latest hook for the worktree, so it stays blocked until
 * the rerun's own result is `complete`.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Cause, Effect, Exit, Schema } from "effect";
import { runFirstAfterCreate } from "./after-create.js";
import type { QueuedTicket } from "./assignments.js";
import type { LoadedFactory } from "./factory-loads.js";
import { beginOperationIn, listOperationsAwaitingRecovery, recordRecoveryResultIn } from "./operations.js";
import type { Operation } from "./operations.js";
import type { Store } from "./store.js";

export interface AfterCreateRecoveryOptions {
  readonly store: Store;
  /** The started factories; another factory's interrupted hooks wait for a run that starts it. */
  readonly factories: ReadonlyArray<LoadedFactory>;
  readonly env?: NodeJS.ProcessEnv;
  /** One operation's claim or rerun failed; the others carry on. Defaults to logging the cause. */
  readonly onFailure?: (operationId: number, cause: Cause.Cause<unknown>) => void;
}

const decodeIntent = Schema.decodeUnknownEffect(Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.String),
  worktreeOperationId: Schema.Number,
  path: Schema.String,
  retryOf: Schema.optional(Schema.Number),
}));

const isFirstAfterCreate = (operation: Operation) =>
  operation.kind === "hook" && operation.intent["hook"] === "after_create" && operation.intent["operation"] === "worktree_create";

/** Closes the interrupted hook and records its rerun as running in one change; `undefined` when nothing reruns. */
const claimRerun = (store: Store, factory: LoadedFactory, interrupted: Operation) => store.change((change) => Effect.gen(function* () {
  const awaiting = yield* change.query(`SELECT 1 FROM operation WHERE id = ? AND status = 'interrupted' AND result IS NULL`, [interrupted.id]);

  if (awaiting.length === 0) {return undefined;}

  const decoded = yield* Effect.exit(decodeIntent(interrupted.intent));

  if (Exit.isFailure(decoded)) {
    yield* recordRecoveryResultIn(change, interrupted.id, { status: "interrupted", result: { rerun: false, reason: "invalid intent" } });

    return undefined;
  }

  const intent = decoded.value;

  const [ticket] = yield* change.query<QueuedTicket>(`SELECT * FROM ticket WHERE factory_id = ? AND number = ?`,
    [interrupted.factoryId, interrupted.ticket]);

  // An ended ticket or a worktree no longer recorded for it has nothing left to set up.
  const reason = ticket === undefined ? "ticket missing"
    : ticket.state === "completed" || ticket.state === "cancelled" ? `ticket ${ticket.state}`
      : ticket.worktree_path === intent.path ? undefined : "worktree no longer recorded";

  const stage = ticket?.stage ?? factory.config.production_lines[ticket?.production_line ?? ""]?.stages[0]?.id;

  if (ticket === undefined || reason !== undefined || stage === undefined) {
    yield* recordRecoveryResultIn(change, interrupted.id, { status: "interrupted", result: { rerun: false, reason: reason ?? "no stage" } });

    return undefined;
  }

  const logPath = join(ticket.directory, "evidence", `after-create-${randomUUID()}.log`);

  const baseIntent = { hook: "after_create", operation: "worktree_create",
    worktreeOperationId: intent.worktreeOperationId, rerunOf: interrupted.id, argv: [...intent.argv], path: intent.path, logPath };

  // A rerun of an operator retry stays one, so its result settles the paused ticket and hold.
  const rerunIntent = intent.retryOf === undefined ? baseIntent : { ...baseIntent, retryOf: intent.retryOf };

  const operation = yield* beginOperationIn(change, { factoryId: interrupted.factoryId, kind: "hook", ticket: ticket.number,
    intent: rerunIntent });

  yield* recordRecoveryResultIn(change, interrupted.id, { status: "interrupted", result: { rerun: true, rerunOperationId: operation.id } });

  return { ticket, stage, argv: intent.argv, path: intent.path, logPath, operation, resume: intent.retryOf !== undefined };
}));

/** Passes a success through; reports a failure (but not a plain interruption) and turns it into `undefined`. */
const report = (onFailure: AfterCreateRecoveryOptions["onFailure"], operationId: number) =>
  <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A | undefined> => {
    if (Exit.isSuccess(exit)) {return Effect.succeed(exit.value);}

    // An interrupted recovery stops quietly; the next startup picks it up again.
    if (Cause.hasInterruptsOnly(exit.cause)) {return Effect.succeed(undefined);}

    if (onFailure === undefined) {
      return Effect.as(Effect.logError(`after_create recovery of operation ${operationId} failed`, exit.cause), undefined);
    }

    onFailure(operationId, exit.cause);

    return Effect.succeed(undefined);
  };

/**
 * Reruns every interrupted first `after_create` of the given factories, concurrently, and returns
 * the reruns that ran. Each claim and rerun is isolated: one failing is reported through
 * `onFailure` and never stops the others. If this is interrupted, a rerun stays running, like any
 * hook after a crash, and the next startup reruns it again.
 */
export const recoverInterruptedAfterCreate = (options: AfterCreateRecoveryOptions) => Effect.gen(function* () {
  const claimed = [];

  for (const factory of options.factories) {
    for (const interrupted of (yield* listOperationsAwaitingRecovery(options.store, factory.factoryId)).filter(isFirstAfterCreate)) {
      const rerun = yield* Effect.exit(claimRerun(options.store, factory, interrupted)).pipe(Effect.flatMap(report(options.onFailure, interrupted.id)));

      if (rerun !== undefined) {claimed.push(rerun);}
    }
  }

  const reruns = yield* Effect.forEach(claimed, (rerun) => Effect.exit(Effect.as(
    runFirstAfterCreate({ store: options.store, ...rerun, env: options.env ?? process.env }),
    rerun.operation,
  )).pipe(Effect.flatMap(report(options.onFailure, rerun.operation.id))), { concurrency: "unbounded" });

  return reruns.filter((operation) => operation !== undefined);
});

/** Runs recovery in the background, so a slow hook never holds up startup. The stop function kills any running rerun. */
export const startAfterCreateRecovery = (options: AfterCreateRecoveryOptions & {
  readonly onRerun?: (operation: Operation) => void;
  readonly onError: (error: Error) => void;
}): (() => Promise<void>) => {
  const controller = new AbortController();

  const done = Effect.runPromiseExit(recoverInterruptedAfterCreate({
    ...options,
    onFailure: options.onFailure ?? ((operationId, cause) => {
      options.onError(new Error(`operation ${operationId}: ${Cause.pretty(cause)}`));
    }),
  }), { signal: controller.signal }).then((exit) => {
    if (Exit.isSuccess(exit)) {
      for (const operation of exit.value) {options.onRerun?.(operation);}
    } else if (!controller.signal.aborted) {
      options.onError(new Error(Cause.pretty(exit.cause)));
    }
  });

  return async () => {
    controller.abort();
    await done;
  };
};
