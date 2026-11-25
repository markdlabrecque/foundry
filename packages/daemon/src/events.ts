/**
 * Durable factory events (PRD §15.1): history rows read back in sequence order, after a cursor,
 * with optional filters. Events are only ever read from history; nothing here writes or rebuilds
 * state (ADR 0001).
 */
import { Effect } from "effect";
import type { EventRecordRef, FactoryEvent } from "@foundry/protocol/management-api";
import type { SqlValue, Store } from "./store.js";

export interface EventPageQuery {
  /** Only events with an ID greater than this. */
  readonly after: number;
  /** Factory ID filter. */
  readonly factory?: string | undefined;
  /** Ticket number filter: rows that name the ticket among their records. */
  readonly ticket?: number | undefined;
  /** Most events to return. */
  readonly limit: number;
}

/** What the management API streams from: pages of history and a signal after each commit. */
export interface EventSource {
  /** Events after the cursor, oldest first, at most `limit`. */
  readonly page: (query: EventPageQuery) => Promise<ReadonlyArray<FactoryEvent>>;
  /** Calls `listener` after each committed change; returns the unsubscribe function. */
  readonly onCommit: (listener: () => void) => () => void;
}

interface HistoryRow {
  readonly sequence: number;
  readonly factory_id: string;
  readonly recorded_at: number;
  readonly kind: string;
  readonly subject: string;
  readonly detail: string;
}

interface RecordRow {
  readonly sequence: number;
  readonly record_kind: string;
  readonly record_id: string;
}

/** Reads one page of events from the store. */
export const readEvents = (store: Store, query: EventPageQuery): Effect.Effect<ReadonlyArray<FactoryEvent>, unknown> =>
  Effect.gen(function* () {
    const where = ["h.sequence > ?"];
    const params: SqlValue[] = [query.after];
    if (query.factory !== undefined) {
      where.push("h.factory_id = ?");
      params.push(query.factory);
    }
    if (query.ticket !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM history_record r
                 WHERE r.sequence = h.sequence AND r.record_kind = 'ticket' AND r.record_id = ?)`,
      );
      params.push(String(query.ticket));
    }
    params.push(query.limit);
    const rows = yield* store.read<HistoryRow>(
      `SELECT h.sequence, h.factory_id, h.recorded_at, h.kind, h.subject, h.detail
       FROM history h WHERE ${where.join(" AND ")} ORDER BY h.sequence LIMIT ?`,
      params,
    );
    if (rows.length === 0) return [];

    const records = new Map<number, EventRecordRef[]>();
    const refs = yield* store.read<RecordRow>(
      `SELECT sequence, record_kind, record_id FROM history_record
       WHERE sequence BETWEEN ? AND ? ORDER BY sequence, record_kind, record_id`,
      [rows[0]!.sequence, rows[rows.length - 1]!.sequence],
    );
    for (const ref of refs) {
      const list = records.get(ref.sequence) ?? [];
      list.push({ kind: ref.record_kind, id: ref.record_id });
      records.set(ref.sequence, list);
    }

    return rows.map(
      (row): FactoryEvent => ({
        id: row.sequence,
        factoryId: row.factory_id,
        recordedAt: new Date(row.recorded_at).toISOString(),
        kind: row.kind,
        subject: row.subject,
        records: records.get(row.sequence) ?? [],
        detail: JSON.parse(row.detail) as unknown,
      }),
    );
  });

/** The store as an event source for the management API. */
export const storeEventSource = (store: Store): EventSource => ({
  page: (query) => Effect.runPromise(readEvents(store, query)),
  onCommit: store.onCommit,
});
