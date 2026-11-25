/**
 * The Foundry store: the one SQLite database (WAL) per state root, opened only
 * by the daemon (PRD §10.1, ADR 0001).
 *
 * This is the only Foundry module that imports Effect's unstable SQL modules
 * (`effect/sql` and `@effect/sql-sqlite-node`). Everything else goes through
 * the Foundry-owned `Store` interface below.
 *
 * Current-state records are authoritative; history is an append-only log
 * beside them. Every change runs through `Store.change`, which commits the
 * state writes and their history rows in one transaction, or neither.
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { Clock, Data, Effect } from "effect";
import type { Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError } from "effect/sql";

/** Table the migrator records applied migrations in. */
const MIGRATIONS_TABLE = "foundry_migrations";

/** A schema migration: plain SQL statements applied in order, once. */
export interface Migration {
  /** Positive, strictly increasing. The highest applied ID is the schema version. */
  readonly id: number;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/** The migrations this build of Foundry knows, oldest first. */
export const foundryMigrations: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: "history",
    statements: [
      // The sequence number is the per-instance event ID. Times are absolute
      // wall-clock milliseconds since the Unix epoch.
      `CREATE TABLE history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        detail TEXT NOT NULL
      ) STRICT`,
      `CREATE TRIGGER history_no_update BEFORE UPDATE ON history
       BEGIN SELECT RAISE(ABORT, 'history is append-only'); END`,
      `CREATE TRIGGER history_no_delete BEFORE DELETE ON history
       BEGIN SELECT RAISE(ABORT, 'history is append-only'); END`,
    ],
  },
  {
    id: 2,
    name: "operator_hold",
    statements: [
      // Operator holds (PRD §10.2): a record type of their own, separate from approvals. A closed
      // hold is kept; the partial index allows at most one open per factory, kind and subject.
      `CREATE TABLE operator_hold (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'cleared')),
        evidence TEXT NOT NULL,
        raised_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        CHECK ((state = 'open') = (closed_at IS NULL))
      ) STRICT`,
      `CREATE UNIQUE INDEX operator_hold_one_open ON operator_hold (factory_id, kind, subject)
       WHERE state = 'open'`,
    ],
  },
];

/** Values that can be bound to a statement parameter. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type StoreErrorReason =
  /** The database file could not be opened or configured. */
  | "Open"
  /** The database was written by a newer Foundry; the daemon refuses to start. */
  | "NewerSchema"
  /** A known migration failed; nothing from it was kept. */
  | "Migration"
  /** A statement failed. */
  | "Sql"
  /** A change wrote no history row, so it was rolled back. */
  | "NoHistory";

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly reason: StoreErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** One history row, appended beside the current-state writes of a change. */
export interface HistoryEntry {
  readonly factoryId: string;
  /** What happened, e.g. `slot.frozen`. */
  readonly kind: string;
  /** What it happened to, e.g. a slot ID. */
  readonly subject: string;
  /** JSON-serialisable detail. */
  readonly detail?: unknown;
}

/** Runs one statement and returns its rows (empty for writes without `RETURNING`). */
export type Query = <Row extends object = Record<string, unknown>>(
  statement: string,
  params?: ReadonlyArray<SqlValue>,
) => Effect.Effect<ReadonlyArray<Row>, StoreError>;

/** The handle a change body uses inside its transaction. */
export interface Change {
  readonly query: Query;
  /** Appends a history row in this transaction; returns its sequence number (event ID). */
  readonly recordHistory: (entry: HistoryEntry) => Effect.Effect<number, StoreError>;
}

export interface Store {
  readonly filename: string;
  /** Highest migration ID applied to the database. */
  readonly schemaVersion: number;
  /** Reads outside a change. Writes belong in `change`. */
  readonly read: Query;
  /**
   * Runs `body` in one transaction. Commits its state writes and history rows
   * together only if it succeeds and recorded at least one history row;
   * otherwise rolls all of it back.
   */
  readonly change: <A, E, R>(
    body: (change: Change) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreError, R>;
}

export interface OpenStoreOptions {
  /** Path to the database file. Its directory must already exist. */
  readonly filename: string;
  /** Defaults to `foundryMigrations`. Overridable so tests can stand in for another build. */
  readonly migrations?: ReadonlyArray<Migration>;
}

const sqlFailure = (reason: StoreErrorReason, message: string) => (cause: unknown) =>
  new StoreError({ reason, message: `${message}: ${describe(cause)}`, cause });

const describe = (cause: unknown): string =>
  SqlError.isSqlError(cause)
    ? describe(cause.reason.cause ?? cause.reason.message)
    : cause instanceof Error
      ? cause.message
      : String(cause);

const makeQuery =
  (sql: SqlClient.SqlClient): Query =>
  (statement, params = []) =>
    sql.unsafe(statement, params).pipe(Effect.mapError(sqlFailure("Sql", "Statement failed"))) as never;

/**
 * Opens the store for the lifetime of the enclosing scope: opens the file in
 * WAL mode, refuses a schema newer than this build knows, then applies any
 * pending migrations in one transaction.
 */
export const openStore = (
  options: OpenStoreOptions,
): Effect.Effect<Store, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const migrations = options.migrations ?? foundryMigrations;
    const known = Math.max(0, ...migrations.map((m) => m.id));

    const sql: SqlClient.SqlClient = yield* SqliteClient.make({ filename: options.filename }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(sqlFailure("Open", `Could not open ${options.filename}`)),
    );
    const query = makeQuery(sql);

    const applied = yield* appliedVersion(query);
    if (applied > known) {
      return yield* new StoreError({
        reason: "NewerSchema",
        message: `${options.filename} has schema version ${applied}, newer than ${known}, the latest this Foundry knows; refusing to open it`,
      });
    }

    yield* SqliteMigrator.run({
      table: MIGRATIONS_TABLE,
      loader: SqliteMigrator.fromRecord(
        Object.fromEntries(
          migrations.map((m) => [
            `${m.id}_${m.name}`,
            Effect.forEach(m.statements, (s) => sql.unsafe(s), { discard: true }),
          ]),
        ),
      ),
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(sqlFailure("Migration", `Could not migrate ${options.filename}`)),
    );

    const change: Store["change"] = (body) =>
      Effect.gen(function* () {
        let historyRows = 0;
        const recordHistory = (entry: HistoryEntry) =>
          Effect.gen(function* () {
            const recordedAt = yield* Clock.currentTimeMillis;
            const rows = yield* query<{ sequence: number }>(
              `INSERT INTO history (factory_id, recorded_at, kind, subject, detail)
               VALUES (?, ?, ?, ?, ?) RETURNING sequence`,
              [entry.factoryId, recordedAt, entry.kind, entry.subject, JSON.stringify(entry.detail ?? null)],
            );
            historyRows += 1;
            return rows[0]!.sequence;
          });
        const result = yield* body({ query, recordHistory });
        if (historyRows === 0) {
          return yield* new StoreError({
            reason: "NoHistory",
            message: "A change must record at least one history row; rolled back",
          });
        }
        return result;
      }).pipe(
        sql.withTransaction,
        Effect.mapError((e) => (SqlError.isSqlError(e) ? sqlFailure("Sql", "Transaction failed")(e) : e)),
      ) as never;

    return {
      filename: options.filename,
      schemaVersion: Math.max(applied, known),
      read: query,
      change,
    } satisfies Store;
  });

/** Highest migration applied to the file, or 0 for a new database. */
const appliedVersion = (query: Query) =>
  Effect.gen(function* () {
    const tables = yield* query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [MIGRATIONS_TABLE]);
    if (tables.length === 0) return 0;
    const rows = yield* query<{ version: number | null }>(
      `SELECT max(migration_id) AS version FROM ${MIGRATIONS_TABLE}`,
    );
    return rows[0]?.version ?? 0;
  });
