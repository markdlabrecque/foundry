/**
 * Per-factory start refusal (PRD §4 "Loading", §11.6, §15.1 `factory.start_refused`).
 *
 * After a run's configuration loads are recorded, each factory's open records are compared with
 * the configuration just loaded. A factory with any open record naming configuration that no
 * longer exists is refused alone: one `factory.start_refused` history row names its blocking
 * records, and the other factories start. A refusal never makes the daemon exit. Records that are
 * closed (a completed or cancelled ticket) never block, whatever their history names.
 *
 * Each record kind has its own reference check (`ReferenceCheck`); this module ships the ticket
 * check. Messages (50b) and delegations (50c) add theirs to `START_REFERENCE_CHECKS`.
 */
import { Effect } from "effect";
import type { FactoryConfig } from "./config/schema.js";
import { ticketRecord, type HistoryRecordRef } from "./history-records.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Query, Store, StoreError } from "./store.js";

/** A factory about to start, with the configuration it was just loaded with. */
export interface StartingFactory {
  readonly factoryId: string;
  readonly config: Pick<FactoryConfig, "production_lines">;
  /** The recorded configuration load this start runs under, if any. */
  readonly loadId?: number;
}

/** Configuration an open record names that the loaded configuration no longer has. */
export interface MissingReference {
  readonly kind: "production_line" | "stage";
  /** The production line it belongs to, or is. */
  readonly line: string;
  /** The stage ID; absent for a production line. */
  readonly stage?: string;
}

/** One open record that blocks a factory's start. */
export interface StartBlocker {
  readonly record: HistoryRecordRef;
  readonly missing: MissingReference;
}

/** Reads one record kind's open records for a factory and returns those naming removed configuration. */
export type ReferenceCheck = (
  query: Query,
  factory: StartingFactory,
) => Effect.Effect<ReadonlyArray<StartBlocker>, StoreError>;

interface OpenTicketRow {
  number: number;
  production_line: string;
  stage: string | null;
}

/**
 * Open tickets: every one not completed or cancelled (backlog, queued, assigned, awaiting
 * approval, paused). A ticket names its production line, and its stage once it has one.
 */
export const ticketReferenceCheck: ReferenceCheck = (query, factory) =>
  Effect.map(
    query<OpenTicketRow>(
      `SELECT number, production_line, stage FROM ticket
       WHERE factory_id = ? AND state NOT IN ('completed', 'cancelled') ORDER BY number`,
      [factory.factoryId],
    ),
    (rows) =>
      rows.flatMap((row): StartBlocker[] => {
        const record = ticketRecord(row.number);
        const lines = factory.config.production_lines;
        if (!Object.hasOwn(lines, row.production_line)) {
          return [{ record, missing: { kind: "production_line", line: row.production_line } }];
        }
        if (row.stage !== null && !lines[row.production_line]!.stages.some((s) => s.id === row.stage)) {
          return [{ record, missing: { kind: "stage", line: row.production_line, stage: row.stage } }];
        }
        return [];
      }),
  );

/** The reference checks a start runs, one per record kind. */
export const START_REFERENCE_CHECKS: ReadonlyArray<ReferenceCheck> = [ticketReferenceCheck];

export interface RefusedFactory {
  readonly factoryId: string;
  readonly blockers: ReadonlyArray<StartBlocker>;
}

export interface StartDecision {
  /** Factories whose open records all name configuration that still exists, in the given order. */
  readonly started: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<RefusedFactory>;
}

/** One line naming a blocker, e.g. `ticket 3 names stage review of line feature`. */
export const describeBlocker = ({ record, missing }: StartBlocker): string =>
  `${record.kind} ${record.id} names ${
    missing.kind === "stage" ? `stage ${missing.stage} of line ${missing.line}` : `production line ${missing.line}`
  }`;

/**
 * Runs every check for every factory and records one `factory.start_refused` row per refused
 * factory, all in one change. With nothing refused, nothing is written.
 */
export const decideFactoryStarts = (
  store: Store,
  factories: ReadonlyArray<StartingFactory>,
  checks: ReadonlyArray<ReferenceCheck> = START_REFERENCE_CHECKS,
): Effect.Effect<StartDecision, StoreError> =>
  Effect.gen(function* () {
    const started: string[] = [];
    const refused: Array<RefusedFactory & { readonly loadId?: number }> = [];
    for (const factory of factories) {
      const blockers = (yield* Effect.forEach(checks, (check) => check(store.read, factory))).flat();
      if (blockers.length === 0) started.push(factory.factoryId);
      else refused.push({ factoryId: factory.factoryId, blockers, ...(factory.loadId === undefined ? {} : { loadId: factory.loadId }) });
    }
    if (refused.length > 0) {
      yield* store.change(({ recordHistory }) =>
        Effect.forEach(
          refused,
          (r) =>
            recordHistory({
              factoryId: r.factoryId,
              kind: "factory.start_refused",
              subject: r.factoryId,
              records: r.blockers.map((b) => b.record),
              detail: {
                configLoad: r.loadId === undefined ? null : String(r.loadId),
                blockers: r.blockers.map((b) => ({ ...b.record, missing: b.missing })),
              },
            }),
          { discard: true },
        ),
      );
    }
    return { started, refused: refused.map(({ factoryId, blockers }) => ({ factoryId, blockers })) };
  });
