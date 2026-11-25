/**
 * Operator holds (PRD §10.2): a record type of their own beside approvals, with at most one open
 * per factory, kind and subject. The `operator_hold` table is current state; every change to it
 * writes a `hold.*` history row in the same transaction (ADR 0001).
 *
 * Raising a hold that is already open never opens a second one: identical evidence changes
 * nothing, and new evidence refreshes the open hold (as a repeated sync conflict does).
 */
import { Clock, Effect, Schema } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import { HoldEvidence, HoldKind, HoldState, holdCommands } from "@foundry/protocol/holds";
import type { HoldListResult, HoldRecord, HoldShowResult } from "@foundry/protocol/holds";
import type { Change, Query, Store, StoreError } from "./store.js";

export interface RaiseHold {
  readonly factoryId: string;
  readonly kind: HoldKind;
  readonly subject: string;
  readonly evidence: HoldEvidence;
}

/**
 * `raised`: a new open hold. `refreshed`: the open hold's evidence was replaced.
 * `unchanged`: the open hold already showed this evidence; nothing was written.
 */
export type RaiseOutcome = "raised" | "refreshed" | "unchanged";

export interface RaiseResult {
  readonly outcome: RaiseOutcome;
  readonly hold: HoldRecord;
}

interface HoldRow {
  readonly id: number;
  readonly factory_id: string;
  readonly kind: string;
  readonly subject: string;
  readonly state: string;
  readonly evidence: string;
  readonly raised_at: number;
  readonly updated_at: number;
  readonly closed_at: number | null;
}

const COLUMNS = `id, factory_id, kind, subject, state, evidence, raised_at, updated_at, closed_at`;

// Columns are decoded as read: a row this build did not write fails loudly instead of passing as a hold.
const decodeKind = Schema.decodeUnknownSync(HoldKind);

const decodeState = Schema.decodeUnknownSync(HoldState);

const decodeEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(HoldEvidence));

const toRecord = (row: HoldRow): HoldRecord => ({
  id: row.id,
  factoryId: row.factory_id,
  kind: decodeKind(row.kind),
  subject: row.subject,
  state: decodeState(row.state),
  evidence: decodeEvidence(row.evidence),
  raisedAt: new Date(row.raised_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
});

const byId = (query: Query, id: number) =>
  Effect.map(query<HoldRow>(`SELECT ${COLUMNS} FROM operator_hold WHERE id = ?`, [id]), (rows) =>
    rows[0] === undefined ? undefined : toRecord(rows[0]),
  );

const openRow = (query: Query, hold: Pick<RaiseHold, "factoryId" | "kind" | "subject">) =>
  Effect.map(
    query<HoldRow>(
      `SELECT ${COLUMNS} FROM operator_hold WHERE factory_id = ? AND kind = ? AND subject = ? AND state = 'open'`,
      [hold.factoryId, hold.kind, hold.subject],
    ),
    (rows) => rows[0],
  );

/**
 * Raises a hold inside a change, or refreshes the one already open for its factory, kind and
 * subject. Identical evidence writes nothing, so the caller's change must record its own history.
 */
export const raiseHoldIn = ({ query, recordHistory }: Change, hold: RaiseHold): Effect.Effect<RaiseResult, StoreError> =>
  Effect.gen(function* () {
    const evidence = JSON.stringify(hold.evidence);
    const existing = yield* openRow(query, hold);

    if (existing !== undefined && existing.evidence === evidence) {
      return { outcome: "unchanged", hold: toRecord(existing) } as const;
    }

    const now = yield* Clock.currentTimeMillis;

    const id =
      existing === undefined
        ? (yield* query<{ id: number }>(
            `INSERT INTO operator_hold (factory_id, kind, subject, state, evidence, raised_at, updated_at)
             VALUES (?, ?, ?, 'open', ?, ?, ?) RETURNING id`,
            [hold.factoryId, hold.kind, hold.subject, evidence, now, now],
          ).pipe(Effect.map((rows) => expectDefined(rows[0], "the inserted hold's id").id)))
        : (yield* query(`UPDATE operator_hold SET evidence = ?, updated_at = ? WHERE id = ?`, [evidence, now, existing.id]),
          existing.id);

    yield* recordHistory({
      factoryId: hold.factoryId,
      kind: "hold.raised",
      subject: hold.subject,
      detail: { holdId: id, kind: hold.kind, refreshed: existing !== undefined, evidence: hold.evidence },
    });

    return { outcome: existing === undefined ? "raised" : "refreshed", hold: expectDefined(yield* byId(query, id), `hold ${id}`) } as const;
  });

/** Raises a hold, or refreshes the one already open for its factory, kind and subject. */
export const raiseHold = (store: Store, hold: RaiseHold): Effect.Effect<RaiseResult, StoreError> =>
  Effect.gen(function* () {
    // The daemon is the only writer, so this read cannot be raced; the unique index backs it up.
    const open = yield* openRow(store.read, hold);

    if (open !== undefined && open.evidence === JSON.stringify(hold.evidence)) {
      return { outcome: "unchanged", hold: toRecord(open) } as const;
    }

    return yield* store.change((change) => raiseHoldIn(change, hold));
  });

/**
 * Closes the open hold of a factory, kind and subject inside a change: `resolved` by an operator
 * command on its subject, `cleared` by the daemon when its cause went away. Returns `undefined`,
 * writing nothing, if no such hold is open.
 */
export const closeOpenHoldIn = (
  { query, recordHistory }: Change,
  hold: Pick<RaiseHold, "factoryId" | "kind" | "subject">,
  state: "resolved" | "cleared",
): Effect.Effect<HoldRecord | undefined, StoreError> =>
  Effect.gen(function* () {
    const open = yield* openRow(query, hold);

    if (open === undefined) {return undefined;}

    const now = yield* Clock.currentTimeMillis;
    yield* query(`UPDATE operator_hold SET state = ?, closed_at = ? WHERE id = ? AND state = 'open'`, [state, now, open.id]);
    yield* recordHistory({
      factoryId: open.factory_id,
      kind: `hold.${state}`,
      subject: open.subject,
      detail: { holdId: open.id, kind: open.kind },
    });

    return expectDefined(yield* byId(query, open.id), `hold ${open.id}`);
  });

/**
 * Closes an open hold: `resolved` by an operator command on its subject, `cleared` by the daemon
 * when its cause went away. Returns `undefined`, writing nothing, if no such hold is open.
 */
export const closeHold = (
  store: Store,
  id: number,
  state: "resolved" | "cleared",
): Effect.Effect<HoldRecord | undefined, StoreError> =>
  Effect.gen(function* () {
    // The daemon is the only writer, so a hold read as open is still open inside the change.
    const current = yield* getHold(store, id);

    if (current === undefined || current.state !== "open") {return undefined;}

    return yield* store.change((change) => closeOpenHoldIn(change, current, state));
  });

/** The open holds, oldest first. */
export const listOpenHolds = (store: Store): Effect.Effect<ReadonlyArray<HoldRecord>, StoreError> =>
  Effect.map(
    store.read<HoldRow>(`SELECT ${COLUMNS} FROM operator_hold WHERE state = 'open' ORDER BY id`),
    (rows) => rows.map(toRecord),
  );

/** One hold by ID, open or closed. */
export const getHold = (store: Store, id: number): Effect.Effect<HoldRecord | undefined, StoreError> =>
  byId(store.read, id);

/** What the management API serves for holds. */
export interface HoldsReader {
  readonly list: () => Promise<HoldListResult>;
  /** `undefined` when no hold has that ID. */
  readonly show: (id: number) => Promise<HoldShowResult | undefined>;
}

/** Serves holds from the store. */
export const storeHoldsReader = (store: Store): HoldsReader => ({
  list: () => Effect.runPromise(Effect.map(listOpenHolds(store), (holds) => ({ holds }))),
  show: (id) =>
    Effect.runPromise(
      Effect.map(getHold(store, id), (hold) => (hold === undefined ? undefined : { hold, commands: holdCommands(hold) })),
    ),
});
