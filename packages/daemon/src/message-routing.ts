/** Station routing only (PRD §6.3): commit the logical slot before delivery can observe it. */
import { Clock, Effect } from "effect";
import type { PlannedSlot } from "./slots.js";
import type { Change, Store, StoreError } from "./store.js";
import { slotRecord, ticketRecord } from "./history-records.js";

export interface RoutingSlot {
  readonly factoryId: string;
  readonly slotId: string;
  readonly station: string;
  readonly ordinal: number;
  readonly condition: string;
}

/** Normal configured slots can hold queued work even while disconnected or busy. Frozen and
 * parked slots cannot acquire new work. Launch/prime readiness is a delivery concern. */
export const selectMessageSlot = (
  factoryId: string,
  recipient: string,
  slots: ReadonlyArray<RoutingSlot>,
  assignedSlot: string | null = null,
): string | null => {
  const eligible = slots.filter((slot) => slot.factoryId === factoryId && slot.station === recipient && slot.condition === "normal");
  const assigned = eligible.find((slot) => slot.slotId === assignedSlot);

  if (assigned !== undefined) {return assigned.slotId;}

  return eligible.toSorted((a, b) => a.ordinal - b.ordinal || (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))[0]?.slotId ?? null;
};

export interface MessageRoutingOptions {
  readonly store: Store;
  readonly slots: ReadonlyArray<PlannedSlot>;
  /** Read-only lookup inside the binding transaction; absent until assignment scheduling is wired. */
  readonly assignedSlot?: (change: Change, factoryId: string, ticket: number) => Effect.Effect<string | null, StoreError>;
  /** An assignment's context has an exact destination, never a fallback station slot. */
  readonly contextSlot?: (change: Change, factoryId: string, messageId: string) => Effect.Effect<string | null, StoreError>;
  readonly inScope?: (factoryId: string) => boolean;
}

export interface MessageBinding {
  readonly id: string;
  readonly factoryId: string;
  readonly sequence: number;
  readonly slotId: string;
}

interface UnboundMessage {
  readonly id: string;
  readonly factory_id: string;
  readonly sequence: number;
  readonly recipient: string;
  readonly ticket_number: number | null;
}

// Store changes require history. Roll back an empty pass without inventing a history event.
const noBindings = Symbol("no bindings");

/** Returns only committed bindings. Never invokes a sender or changes a ticket assignment.
 * Repeated/concurrent passes select only unbound rows; a replacement launch cannot change them. */
export const bindStationMessages = (options: MessageRoutingOptions): Effect.Effect<ReadonlyArray<MessageBinding>, StoreError> =>
  options.store.change((change) => Effect.gen(function* () {
    const messages = yield* change.query<UnboundMessage>(
      `SELECT id, factory_id, sequence, recipient, ticket_number FROM message
       WHERE status = 'unbound' AND bound_slot IS NULL ORDER BY factory_id, sequence`,
    );

    const conditions = yield* change.query<{ factory_id: string; slot_id: string; condition: string }>(
      `SELECT factory_id, slot_id, condition FROM slot`,
    );

    const slots: Array<RoutingSlot> = options.slots.flatMap((slot) => {
      const row = conditions.find((condition) => condition.factory_id === slot.factoryId && condition.slot_id === slot.slotId);

      return row === undefined ? [] : [{ factoryId: slot.factoryId, slotId: slot.slotId,
        station: slot.station.address, ordinal: slot.ordinal, condition: row.condition }];
    });

    const bound: Array<MessageBinding> = [];

    for (const message of messages) {
      if (options.inScope !== undefined && !options.inScope(message.factory_id)) {continue;}

      const assigned = message.ticket_number === null || options.assignedSlot === undefined
        ? null : yield* options.assignedSlot(change, message.factory_id, message.ticket_number);

      const contextSlot = options.contextSlot === undefined
        ? null : yield* options.contextSlot(change, message.factory_id, message.id);

      const slotId = contextSlot === null
        ? selectMessageSlot(message.factory_id, message.recipient, slots, assigned)
        : slots.find((slot) => slot.factoryId === message.factory_id && slot.station === message.recipient
          && slot.slotId === contextSlot && slot.condition === "normal")?.slotId ?? null;

      if (slotId === null) {continue;}

      const now = yield* Clock.currentTimeMillis;

      const updated = yield* change.query<{ id: string }>(
        `UPDATE message SET status = 'bound', bound_slot = ?, bound_at = ?
         WHERE id = ? AND status = 'unbound' AND bound_slot IS NULL RETURNING id`, [slotId, now, message.id],
      );

      if (updated.length === 0) {continue;}

      // The notice and request acquire the same selected slot in this transaction.
      yield* change.query(
        `UPDATE agent_request SET recipient_slot = ? WHERE factory_id = ? AND notice_id = ? AND recipient_slot IS NULL`,
        [slotId, message.factory_id, message.id],
      );

      yield* change.query(
        `UPDATE delegation SET recipient_slot = ? WHERE factory_id = ? AND notice_id = ? AND recipient_slot IS NULL`,
        [slotId, message.factory_id, message.id],
      );

      yield* change.recordHistory({ factoryId: message.factory_id, kind: "message.bound", subject: message.id,
        detail: { sequence: message.sequence, slotId },
        records: [slotRecord(slotId), ...(message.ticket_number === null ? [] : [ticketRecord(message.ticket_number)])],
      });
      bound.push({ id: message.id, factoryId: message.factory_id, sequence: message.sequence, slotId });
    }

    return bound.length === 0 ? yield* Effect.fail(noBindings) : bound;
  })).pipe(Effect.catchIf((error) => error === noBindings, () => Effect.succeed([])));

/** Coalesces commit notifications, including acceptance, slot creation and unfreeze. No polling.
 * The returned stop drains an in-flight pass before the store closes. */
export const startMessageRouting = (options: MessageRoutingOptions & { readonly onError: (cause: unknown) => void }) => {
  let stopped = false;
  let pending = false;
  let running: Promise<void> | undefined;

  const schedule = () => {
    if (stopped) {return;}

    pending = true;

    if (running !== undefined) {return;}

    running = Promise.resolve().then(async () => {
      while (pending && !stopped) {
        pending = false;

        try {await Effect.runPromise(bindStationMessages(options));}
        catch (cause) {options.onError(cause);}
      }
    }).finally(() => {
      running = undefined;

      // A commit may arrive after the loop settles but before this continuation runs.
      if (pending && !stopped) {schedule();}
    });
  };

  const unsubscribe = options.store.onCommit(schedule);
  schedule();

  return async () => {
    stopped = true;
    unsubscribe();
    await running;
  };
};
