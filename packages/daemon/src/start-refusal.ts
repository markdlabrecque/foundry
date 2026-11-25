/**
 * Per-factory start refusal (PRD §4 "Loading", §11.6, §15.1 `factory.start_refused`).
 *
 * After a run's configuration loads are recorded, each factory's open records are compared with
 * the configuration just loaded. A factory with any open record naming configuration that no
 * longer exists is refused alone: one `factory.start_refused` history row names its blocking
 * records, and the other factories start. A refusal never makes the daemon exit. Records that are
 * closed (a completed or cancelled ticket, an acknowledged/closed message, or a resolved
 * delegation) never block, whatever their history names. Each record kind has its own
 * reference check (`ReferenceCheck`).
 */
import { Effect } from "effect";
import { slotIdOf } from "@foundry/protocol/slots-api";
import type { FactoryConfig } from "./config/schema.js";
import { ticketRecord } from "./history-records.js";
import type { HistoryRecordRef } from "./history-records.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Query, Store, StoreError } from "./store.js";

/** A factory about to start, with the configuration it was just loaded with. */
export interface StartingFactory {
  readonly factoryId: string;
  readonly config: Pick<FactoryConfig, "production_lines" | "rooms">;
  /** The recorded configuration load this start runs under, if any. */
  readonly loadId?: number;
}

/** Configuration an open record names that the loaded configuration no longer has. */
export type MissingReference =
  | {
    readonly kind: "production_line" | "stage";
    /** The production line it belongs to, or is. */
    readonly line: string;
    /** The stage ID; absent for a production line. */
    readonly stage?: string;
  }
  | { readonly kind: "station"; readonly station: string }
  | { readonly kind: "slot"; readonly slot: string };

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
      rows.flatMap((row): Array<StartBlocker> => {
        const record = ticketRecord(row.number);
        const lines = factory.config.production_lines;

        const line = Object.hasOwn(lines, row.production_line) ? lines[row.production_line] : undefined;

        if (line === undefined) {
          return [{ record, missing: { kind: "production_line", line: row.production_line } }];
        }

        if (row.stage !== null && !line.stages.some((s) => s.id === row.stage)) {
          return [{ record, missing: { kind: "stage", line: row.production_line, stage: row.stage } }];
        }

        return [];
      }),
  );

interface OpenMessageRow {
  id: string;
  recipient: string;
  bound_slot: string | null;
}

/** The station addresses and fixed slots present in this configuration load. */
const configuredDestinations = (factory: StartingFactory) => {
  const stations = new Set<string>();
  const slots = new Set<string>();

  for (const [roomName, room] of Object.entries(factory.config.rooms)) {
    for (const [stationName, station] of Object.entries(room.stations)) {
      stations.add(`${roomName}.${stationName}`);

      for (let ordinal = 1; ordinal <= (station.instances ?? 1); ordinal++) {
        slots.add(slotIdOf(stationName, ordinal));
      }
    }
  }

  return { stations, slots };
};

/** Check current durable destinations and immutable bindings, never senders or delivery history. */
export const messageReferenceCheck: ReferenceCheck = (query, factory) => {
  const { stations, slots } = configuredDestinations(factory);

  return Effect.map(
    query<OpenMessageRow>(
      `SELECT id, recipient, bound_slot FROM message
       WHERE factory_id = ? AND status IN ('unbound', 'bound', 'sent', 'indeterminate') ORDER BY sequence`,
      [factory.factoryId],
    ),
    (rows) => rows.flatMap((row): Array<StartBlocker> => {
      const record = { kind: "message", id: row.id };
      const blockers: Array<StartBlocker> = [];

      if (!stations.has(row.recipient)) {
        blockers.push({ record, missing: { kind: "station", station: row.recipient } });
      }

      if (row.bound_slot !== null && !slots.has(row.bound_slot)) {
        blockers.push({ record, missing: { kind: "slot", slot: row.bound_slot } });
      }

      return blockers;
    }),
  );
};

interface OpenDelegationRow {
  id: string;
  delegating_slot: string;
  recipient: string;
  recipient_slot: string | null;
}

/** An open obligation still needs its delegator and its recipient, even after notice acknowledgement. */
export const delegationReferenceCheck: ReferenceCheck = (query, factory) => {
  const { stations, slots } = configuredDestinations(factory);

  return Effect.map(
    query<OpenDelegationRow>(
      `SELECT id, delegating_slot, recipient, recipient_slot FROM delegation
       WHERE factory_id = ? AND status = 'open' ORDER BY accepted_at, id`,
      [factory.factoryId],
    ),
    (rows) => rows.flatMap((row): Array<StartBlocker> => {
      const record = { kind: "delegation", id: row.id };
      const blockers: Array<StartBlocker> = [];

      if (!stations.has(row.recipient)) {
        blockers.push({ record, missing: { kind: "station", station: row.recipient } });
      }

      for (const slot of new Set([row.delegating_slot, row.recipient_slot])) {
        if (slot !== null && !slots.has(slot)) {
          blockers.push({ record, missing: { kind: "slot", slot } });
        }
      }

      return blockers;
    }),
  );
};

/** The reference checks a start runs, one per record kind. */
export const START_REFERENCE_CHECKS: ReadonlyArray<ReferenceCheck> = [ticketReferenceCheck, messageReferenceCheck, delegationReferenceCheck];

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
export const describeBlocker = ({ record, missing }: StartBlocker): string => {
  let reference: string;

  switch (missing.kind) {
    case "station": reference = `station ${missing.station}`; break;
    case "slot": reference = `slot ${missing.slot}`; break;
    case "stage": reference = `stage ${missing.stage} of line ${missing.line}`; break;
    case "production_line": reference = `production line ${missing.line}`; break;
  }

  return `${record.kind} ${record.id} names ${reference}`;
};

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
    const started: Array<string> = [];
    const refused: Array<RefusedFactory & { readonly loadId?: number }> = [];

    for (const factory of factories) {
      const blockers = (yield* Effect.forEach(checks, (check) => check(store.read, factory))).flat();

      if (blockers.length === 0) {started.push(factory.factoryId);}
      else {refused.push(factory.loadId === undefined ? { factoryId: factory.factoryId, blockers } : { factoryId: factory.factoryId, blockers, loadId: factory.loadId });}
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
