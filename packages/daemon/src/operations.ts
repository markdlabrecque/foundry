/**
 * Operations (PRD §9.4): repository actions the daemon performs itself. One record type covers
 * integration, source sync, worktree creation, each hook run and cleanup. The `operation` table is
 * current state; every change to it writes an `operation.*` history row in the same transaction
 * (ADR 0001).
 *
 * - Intent first, result after: an operation commits as `running`, with its intent, before any
 *   Git or hook action starts. Its result commits afterwards, in the same change as everything it
 *   causes.
 * - The integration and sync queue is the `queued` integration and sync operations of a factory,
 *   so an approved integration or a requested sync survives a restart. At most one of them runs
 *   per factory at a time: admission checks and claims in one change, and a partial unique index
 *   backs that up.
 * - On reopen the stored records are read as they are; nothing is rebuilt by replay. At startup,
 *   before host reconciliation, `interruptRunningOperations` marks every running operation
 *   interrupted (PRD §10.2 step 1). An interrupted operation with no result is awaiting recovery
 *   and keeps its factory's queue closed; per-kind recovery closes it by recording a result
 *   (step 3). Other factories' queues are unaffected.
 */
import { Clock, Data, Effect, Schema } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import { ticketRecord } from "./history-records.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Change, Query, Store, StoreError } from "./store.js";

/** The operation kinds of PRD §9.4. */
export const OPERATION_KINDS = ["integration", "sync", "worktree_create", "hook", "cleanup"] as const;

export const OperationKind = Schema.Literals(OPERATION_KINDS);

export type OperationKind = typeof OperationKind.Type;

/** The kinds that go through a factory's integration and sync queue, one running at a time. */
export const QUEUED_OPERATION_KINDS = ["integration", "sync"] as const;

export type QueuedOperationKind = (typeof QUEUED_OPERATION_KINDS)[number];

/** The kinds that run as soon as they are recorded, outside the queue. */
export type DirectOperationKind = Exclude<OperationKind, QueuedOperationKind>;

export const OPERATION_STATUSES = ["queued", "running", "interrupted", "complete", "failed", "indeterminate"] as const;

export const OperationStatus = Schema.Literals(OPERATION_STATUSES);

export type OperationStatus = typeof OperationStatus.Type;

/** The statuses an action's result can record. */
export type OperationResultStatus = Extract<OperationStatus, "complete" | "failed" | "indeterminate">;

/** What an operation sets out to do, or what it did: kind-specific fields, JSON-serialisable. */
export const OperationDetail = Schema.Record(Schema.String, Schema.Json);

export type OperationDetail = typeof OperationDetail.Type;

export interface Operation {
  readonly id: number;
  readonly factoryId: string;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  /** The ticket the operation concerns; `null` for a sync. */
  readonly ticket: number | null;
  readonly intent: OperationDetail;
  /** `null` until a result commits. */
  readonly result: OperationDetail | null;
  /** ISO 8601. */
  readonly queuedAt: string;
  /** ISO 8601 time it committed as running; `null` while queued. */
  readonly startedAt: string | null;
  /** ISO 8601 time its result committed; `null` until then. */
  readonly finishedAt: string | null;
}

export interface OperationRequest<K extends OperationKind> {
  readonly factoryId: string;
  readonly kind: K;
  readonly ticket?: number;
  readonly intent: OperationDetail;
}

export interface OperationOutcome {
  readonly status: OperationResultStatus;
  readonly result: OperationDetail;
}

interface OperationRow {
  readonly id: number;
  readonly factory_id: string;
  readonly kind: string;
  readonly status: string;
  readonly ticket_number: number | null;
  readonly intent: string;
  readonly result: string | null;
  readonly queued_at: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
}

const COLUMNS = `id, factory_id, kind, status, ticket_number, intent, result, queued_at, started_at, finished_at`;

const QUEUED_KINDS_SQL = QUEUED_OPERATION_KINDS.map((k) => `'${k}'`).join(", ");

// Columns are decoded as read: a row this build did not write fails loudly instead of passing as an operation.
const decodeKind = Schema.decodeUnknownSync(OperationKind);

const decodeStatus = Schema.decodeUnknownSync(OperationStatus);

const decodeDetail = Schema.decodeUnknownSync(Schema.fromJsonString(OperationDetail));

const iso = (millis: number | null): string | null => (millis === null ? null : new Date(millis).toISOString());

const toOperation = (row: OperationRow): Operation => ({
  id: row.id,
  factoryId: row.factory_id,
  kind: decodeKind(row.kind),
  status: decodeStatus(row.status),
  ticket: row.ticket_number,
  intent: decodeDetail(row.intent),
  result: row.result === null ? null : decodeDetail(row.result),
  queuedAt: new Date(row.queued_at).toISOString(),
  startedAt: iso(row.started_at),
  finishedAt: iso(row.finished_at),
});

const byId = (query: Query, id: number) =>
  Effect.map(query<OperationRow>(`SELECT ${COLUMNS} FROM operation WHERE id = ?`, [id]), (rows) =>
    rows[0] === undefined ? undefined : toOperation(rows[0]),
  );

const mustExist = (query: Query, id: number) =>
  Effect.map(byId(query, id), (operation) => expectDefined(operation, `operation ${id}`));

const recordsOf = (ticket: number | null) => (ticket === null ? [] : [ticketRecord(ticket)]);

const insert = (change: Change, request: OperationRequest<OperationKind>, status: "queued" | "running") =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const ticket = request.ticket ?? null;

    const rows = yield* change.query<{ id: number }>(
      `INSERT INTO operation (factory_id, kind, status, ticket_number, intent, queued_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [request.factoryId, request.kind, status, ticket, JSON.stringify(request.intent), now, status === "running" ? now : null],
    );

    const id = expectDefined(rows[0], "the inserted operation's id").id;

    yield* change.recordHistory({
      factoryId: request.factoryId,
      kind: status === "queued" ? "operation.queued" : "operation.started",
      subject: String(id),
      detail: { operationId: id, kind: request.kind, intent: request.intent },
      records: recordsOf(ticket),
    });

    return yield* mustExist(change.query, id);
  });

/** Puts an integration or a sync on its factory's queue. It runs when `startNextOperation` admits it. */
export const enqueueOperationIn = (change: Change, request: OperationRequest<QueuedOperationKind>): Effect.Effect<Operation, StoreError> =>
  insert(change, request, "queued");

export const enqueueOperation = (
  store: Store,
  request: OperationRequest<QueuedOperationKind>,
): Effect.Effect<Operation, StoreError> => store.change((change) => insert(change, request, "queued"));

/**
 * Records a worktree creation, hook run or cleanup as running, with its intent, before its action
 * starts. These do not go through the queue.
 */
export const beginOperationIn = (
  change: Change,
  request: OperationRequest<DirectOperationKind>,
): Effect.Effect<Operation, StoreError> => insert(change, request, "running");

export const beginOperation = (
  store: Store,
  request: OperationRequest<DirectOperationKind>,
): Effect.Effect<Operation, StoreError> => store.change((change) => beginOperationIn(change, request));

/** Rolls back an admission that found nothing to start; never leaves this module. */
class NothingAdmitted extends Data.TaggedError("NothingAdmitted") {}

/** Rolls back an interruption pass that found nothing running; never leaves this module. */
class NothingInterrupted extends Data.TaggedError("NothingInterrupted") {}

/** An interrupted operation with no recorded result: recovery has not reconciled it yet. */
const AWAITING_RECOVERY_SQL = `status = 'interrupted' AND result IS NULL`;

/**
 * An integration recovery could not classify: the operator declares it landed or not (PRD §10.2).
 * Its recorded result is the queue's closing cause.
 */
const INDETERMINATE_INTEGRATION_SQL = `kind = 'integration' AND status = 'indeterminate'`;

/**
 * Admits the factory's oldest queued integration or sync: commits it as running and returns it.
 * Returns `undefined`, writing nothing, while one of them is already running there, while any of
 * the factory's operations is interrupted and awaiting recovery (PRD §10.2 step 3), while one of
 * its integrations is indeterminate (§9.4), or when none is queued. The check and the claim are one transaction.
 */
export const startNextOperation = (store: Store, factoryId: string): Effect.Effect<Operation | undefined, StoreError> =>
  store
    .change(({ query, recordHistory }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        // Selected and claimed in one transaction (`BEGIN IMMEDIATE` on the daemon's one
        // connection), so no other admission can commit in between. A second running row would
        // also violate `operation_one_running_per_factory`.
        const claimed = yield* query<OperationRow>(
          `UPDATE operation SET status = 'running', started_at = ?
           WHERE id = (
             SELECT id FROM operation
             WHERE factory_id = ? AND kind IN (${QUEUED_KINDS_SQL}) AND status = 'queued'
               AND NOT EXISTS (
                 SELECT 1 FROM operation WHERE factory_id = ? AND kind IN (${QUEUED_KINDS_SQL}) AND status = 'running')
               AND NOT EXISTS (
                 SELECT 1 FROM operation WHERE factory_id = ? AND ((${AWAITING_RECOVERY_SQL}) OR (${INDETERMINATE_INTEGRATION_SQL})))
             ORDER BY id LIMIT 1)
           RETURNING ${COLUMNS}`,
          [now, factoryId, factoryId, factoryId],
        );

        const row = claimed[0];

        // Nothing to admit: roll back the empty change instead of writing a history row for it.
        if (row === undefined) {return yield* new NothingAdmitted();}

        const id = row.id;
        const operation = toOperation(row);
        yield* recordHistory({
          factoryId,
          kind: "operation.started",
          subject: String(id),
          detail: { operationId: id, kind: operation.kind, intent: operation.intent },
          records: recordsOf(operation.ticket),
        });

        return operation;
      }),
    )
    .pipe(Effect.catchTag("NothingAdmitted", () => Effect.succeed(undefined)));

/**
 * Commits a running operation's result inside `change`, so it lands together with everything the
 * operation causes. Dies if the operation is not running: a result for anything else is a bug.
 */
export const recordOperationResult = (
  change: Change,
  id: number,
  outcome: OperationOutcome,
): Effect.Effect<Operation, StoreError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* change.query<OperationRow>(
      `UPDATE operation SET status = ?, result = ?, finished_at = ? WHERE id = ? AND status = 'running'
       RETURNING ${COLUMNS}`,
      [outcome.status, JSON.stringify(outcome.result), now, id],
    );

    const operation = toOperation(expectDefined(rows[0], `running operation ${id}`));

    yield* change.recordHistory({
      factoryId: operation.factoryId,
      kind: `operation.${outcome.status}`,
      subject: String(id),
      detail: { operationId: id, kind: operation.kind, result: outcome.result },
      records: recordsOf(operation.ticket),
    });

    return operation;
  });

/**
 * Runs `action` for an operation already committed as running, then commits its result in a
 * change of its own. An operation whose result must commit together with other records it causes
 * calls `recordOperationResult` inside that change instead.
 *
 * If the action fails or is interrupted, the operation stays running, exactly as after a crash:
 * what it did is unknown until recovery reconciles it (PRD §10.2), and the factory's queue stays
 * closed until then. Dies, running nothing, if `operation` is not running: an operation is
 * admitted by `startNextOperation` or recorded by `beginOperation` before its action may start.
 */
export const runOperation = <E, R>(
  store: Store,
  operation: Operation,
  action: (operation: Operation) => Effect.Effect<OperationOutcome, E, R>,
): Effect.Effect<Operation, E | StoreError, R> =>
  Effect.gen(function* () {
    if (operation.status !== "running") {
      return yield* Effect.die(new Error(`operation ${operation.id} is ${operation.status}, not running; its action must not start`));
    }

    const outcome = yield* action(operation);

    return yield* store.change((change) => recordOperationResult(change, operation.id, outcome));
  });

/**
 * Adds `fields` to a running operation's recorded intent, before its next step changes anything,
 * so recovery can read what the action learned so far (a sync records the head it started from
 * and the commit it fetched before it merges). Dies if the operation is not running.
 */
export const extendOperationIntent = (
  store: Store,
  id: number,
  fields: OperationDetail,
): Effect.Effect<Operation, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      const current = yield* mustExist(change.query, id);

      if (current.status !== "running") {
        return yield* Effect.die(new Error(`operation ${id} is ${current.status}, not running; its intent is fixed`));
      }

      const intent = { ...current.intent, ...fields };
      yield* change.query(`UPDATE operation SET intent = ? WHERE id = ?`, [JSON.stringify(intent), id]);
      yield* change.recordHistory({
        factoryId: current.factoryId,
        kind: "operation.progressed",
        subject: String(id),
        detail: { operationId: id, kind: current.kind, intent },
        records: recordsOf(current.ticket),
      });

      return yield* mustExist(change.query, id);
    }),
  );

/**
 * Startup recovery, PRD §10.2 step 1: marks every operation recorded as running, in every factory,
 * as interrupted, in one change with an `operation.interrupted` history row each. Runs once the
 * database is open and before the Worker Host is asked about slots, while nothing can be running
 * in this daemon. Queued operations are untouched. Each affected factory's queue stays closed
 * until its interrupted operations are reconciled (`listOperationsAwaitingRecovery`); other
 * factories keep admitting work. Returns the interrupted operations, oldest first; writes nothing
 * when none was running.
 */
export const interruptRunningOperations = (store: Store): Effect.Effect<ReadonlyArray<Operation>, StoreError> =>
  store
    .change(({ query, recordHistory }) =>
      Effect.gen(function* () {
        const rows = yield* query<OperationRow>(
          `UPDATE operation SET status = 'interrupted' WHERE status = 'running' RETURNING ${COLUMNS}`,
        );

        if (rows.length === 0) {return yield* new NothingInterrupted();}

        const operations = rows.map(toOperation).toSorted((a, b) => a.id - b.id);

        for (const operation of operations) {
          yield* recordHistory({
            factoryId: operation.factoryId,
            kind: "operation.interrupted",
            subject: String(operation.id),
            detail: { operationId: operation.id, kind: operation.kind, intent: operation.intent },
            records: recordsOf(operation.ticket),
          });
        }

        return operations;
      }),
    )
    .pipe(Effect.catchTag("NothingInterrupted", () => Effect.succeed([])));

/**
 * A factory's interrupted operations that recovery has not reconciled yet, oldest first. While
 * any is listed, the factory's integration and sync queue admits nothing (PRD §10.2 step 3).
 */
export const listOperationsAwaitingRecovery = (
  store: Store,
  factoryId: string,
): Effect.Effect<ReadonlyArray<Operation>, StoreError> =>
  Effect.map(
    store.read<OperationRow>(
      `SELECT ${COLUMNS} FROM operation WHERE factory_id = ? AND ${AWAITING_RECOVERY_SQL} ORDER BY id`,
      [factoryId],
    ),
    (rows) => rows.map(toOperation),
  );

/**
 * Records recovery's verdict on an interrupted operation that awaits recovery, inside `change`, so
 * it lands with everything the verdict causes. `interrupted` keeps the status (a sync that is never
 * rerun) but, with its result recorded, no longer closes the queue. `indeterminate` records an
 * integration recovery could not classify; it keeps the factory's queue closed, with the result as
 * the recorded cause, until the operator declares it (PRD §9.4, §10.2). Dies if the operation is
 * not awaiting recovery: a verdict for anything else is a bug. A rerun from the start is
 * `requeueInterruptedOperationIn`.
 */
export const recordRecoveryResultIn = (
  change: Change,
  id: number,
  outcome: { readonly status: "complete" | "failed" | "interrupted" | "indeterminate"; readonly result: OperationDetail },
): Effect.Effect<Operation, StoreError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* change.query<OperationRow>(
      `UPDATE operation SET status = ?, result = ?, finished_at = ? WHERE id = ? AND ${AWAITING_RECOVERY_SQL}
       RETURNING ${COLUMNS}`,
      [outcome.status, JSON.stringify(outcome.result), now, id],
    );

    const operation = toOperation(expectDefined(rows[0], `operation ${id} awaiting recovery`));

    // Only an indeterminate integration keeps the queue closed; any other kind would reopen it.
    if (outcome.status === "indeterminate" && operation.kind !== "integration") {
      return yield* Effect.die(new Error(`operation ${id} is a ${operation.kind}; only an integration can be recovered indeterminate`));
    }

    yield* change.recordHistory({
      factoryId: operation.factoryId,
      kind: "operation.recovered",
      subject: String(id),
      detail: { operationId: id, kind: operation.kind, status: outcome.status, result: outcome.result },
      records: recordsOf(operation.ticket),
    });

    return operation;
  });

/**
 * Recovery's rerun-from-start verdict on an interrupted integration or sync awaiting recovery,
 * inside `change`: puts it back on its factory's queue with `intent` in place of what the
 * interrupted run recorded (kept in its history). It keeps its ID, so it runs before anything
 * queued after it. Dies if the operation is not a queued kind awaiting recovery.
 */
export const requeueInterruptedOperationIn = (
  change: Change,
  id: number,
  intent: OperationDetail,
): Effect.Effect<Operation, StoreError> =>
  Effect.gen(function* () {
    const [previous] = yield* change.query<{ intent: string }>(`SELECT intent FROM operation WHERE id = ?`, [id]);

    const rows = yield* change.query<OperationRow>(
      `UPDATE operation SET status = 'queued', started_at = NULL, intent = ?
       WHERE id = ? AND kind IN (${QUEUED_KINDS_SQL}) AND ${AWAITING_RECOVERY_SQL}
       RETURNING ${COLUMNS}`,
      [JSON.stringify(intent), id],
    );

    const operation = toOperation(expectDefined(rows[0], `queued-kind operation ${id} awaiting recovery`));

    yield* change.recordHistory({
      factoryId: operation.factoryId,
      kind: "operation.requeued",
      subject: String(id),
      detail: { operationId: id, kind: operation.kind, intent, previousIntent: previous === undefined ? null : decodeDetail(previous.intent) },
      records: recordsOf(operation.ticket),
    });

    return operation;
  });

/**
 * The operator declared an indeterminate integration landed (PRD §10.2), inside `change`: it
 * completes with `result`, and its recovery evidence stays in its history. Returns `undefined`,
 * writing nothing, if the operation is not an indeterminate integration.
 */
export const completeIndeterminateIntegrationIn = (
  change: Change,
  id: number,
  result: OperationDetail,
): Effect.Effect<Operation | undefined, StoreError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [previous] = yield* change.query<{ result: string | null }>(`SELECT result FROM operation WHERE id = ?`, [id]);

    const rows = yield* change.query<OperationRow>(
      `UPDATE operation SET status = 'complete', result = ?, finished_at = ? WHERE id = ? AND ${INDETERMINATE_INTEGRATION_SQL}
       RETURNING ${COLUMNS}`,
      [JSON.stringify(result), now, id],
    );

    if (rows[0] === undefined) {return undefined;}

    const operation = toOperation(rows[0]);

    yield* change.recordHistory({
      factoryId: operation.factoryId,
      kind: "operation.declared",
      subject: String(id),
      detail: { operationId: id, kind: operation.kind, status: "complete", result,
        previousResult: previous === undefined || previous.result === null ? null : decodeDetail(previous.result) },
      records: recordsOf(operation.ticket),
    });

    return operation;
  });

/**
 * The operator declared an indeterminate integration not landed (PRD §10.2), inside `change`: it
 * goes back on its factory's queue with `intent` in place of the interrupted run's, which stays in
 * its history with recovery's evidence. It keeps its ID, so it runs before anything queued after
 * it. Returns `undefined`, writing nothing, if the operation is not an indeterminate integration.
 */
export const requeueIndeterminateIntegrationIn = (
  change: Change,
  id: number,
  intent: OperationDetail,
): Effect.Effect<Operation | undefined, StoreError> =>
  Effect.gen(function* () {
    const [previous] = yield* change.query<{ intent: string; result: string | null }>(`SELECT intent, result FROM operation WHERE id = ?`, [id]);

    const rows = yield* change.query<OperationRow>(
      `UPDATE operation SET status = 'queued', started_at = NULL, result = NULL, finished_at = NULL, intent = ?
       WHERE id = ? AND ${INDETERMINATE_INTEGRATION_SQL}
       RETURNING ${COLUMNS}`,
      [JSON.stringify(intent), id],
    );

    if (rows[0] === undefined) {return undefined;}

    const operation = toOperation(rows[0]);

    yield* change.recordHistory({
      factoryId: operation.factoryId,
      kind: "operation.requeued",
      subject: String(id),
      detail: { operationId: id, kind: operation.kind, intent,
        previousIntent: previous === undefined ? null : decodeDetail(previous.intent),
        previousResult: previous === undefined || previous.result === null ? null : decodeDetail(previous.result) },
      records: recordsOf(operation.ticket),
    });

    return operation;
  });

/** One operation by ID, in any status. */
export const getOperation = (store: Store, id: number): Effect.Effect<Operation | undefined, StoreError> =>
  byId(store.read, id);

/** A factory's operations, oldest first. */
export const listOperations = (store: Store, factoryId: string): Effect.Effect<ReadonlyArray<Operation>, StoreError> =>
  Effect.map(
    store.read<OperationRow>(`SELECT ${COLUMNS} FROM operation WHERE factory_id = ? ORDER BY id`, [factoryId]),
    (rows) => rows.map(toOperation),
  );
