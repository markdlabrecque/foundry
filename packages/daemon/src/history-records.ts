/**
 * The records a history row concerns (PRD §15.1), in the one format the event filters match.
 * Kept apart from `store.ts` so modules can use these without loading `node:sqlite`.
 */

/** A record a history row concerns. */
export interface HistoryRecordRef {
  readonly kind: string;
  readonly id: string;
}

/** Record kind the `--ticket` event filter matches. */
export const TICKET_RECORD_KIND = "ticket";

/** The ref for a ticket. Use these helpers, not literals. */
export const ticketRecord = (ticket: number): HistoryRecordRef => ({ kind: TICKET_RECORD_KIND, id: String(ticket) });

/** The ref for a slot. */
export const slotRecord = (slotId: string): HistoryRecordRef => ({ kind: "slot", id: slotId });
