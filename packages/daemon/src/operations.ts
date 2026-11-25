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
 * - On reopen the stored records are read as they are; nothing is rebuilt by replay. Marking
 *   running operations interrupted and reconciling them is recovery's job (PRD §10.2).
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
export const enqueueOperation = (
  store: Store,
  request: OperationRequest<QueuedOperationKind>,
): Effect.Effect<Operation, StoreError> => store.change((change) => insert(change, request, "queued"));

/**
 * Records a worktree creation, hook run or cleanup as running, with its intent, before its action
 * starts. These do not go through the queue.
 */
export const beginOperation = (
  store: Store,
  request: OperationRequest<DirectOperationKind>,
): Effect.Effect<Operation, StoreError> => store.change((change) => insert(change, request, "running"));

/** Rolls back an admission that found nothing to start; never leaves this module. */
class NothingAdmitted extends Data.TaggedError("NothingAdmitted") {}

/**
 * Admits the factory's oldest queued integration or sync: commits it as running and returns it.
 * Returns `undefined`, writing nothing, while one of them is already running there or none is
 * queued. The check and the claim are one transaction.
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
             ORDER BY id LIMIT 1)
           RETURNING ${COLUMNS}`,
          [now, factoryId, factoryId],
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
 * operation causes. Fails if the operation is not running.
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
 * Runs `action` for an operation already committed as running, then commits its result. If the
 * action fails or is interrupted, the operation stays running, exactly as after a crash: what it
 * did is unknown until recovery reconciles it (PRD §10.2), and the factory's queue stays closed.
 */
export const runOperation = <E, R>(
  store: Store,
  operation: Operation,
  action: (operation: Operation) => Effect.Effect<OperationOutcome, E, R>,
): Effect.Effect<Operation, E | StoreError, R> =>
  Effect.gen(function* () {
    const outcome = yield* action(operation);

    return yield* store.change((change) => recordOperationResult(change, operation.id, outcome));
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
