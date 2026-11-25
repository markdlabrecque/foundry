/** PRD §5.3, §10.2: observe only injected, unacknowledged work on live channels.
 * Absolute injection times survive daemon downtime; channel liveness never does. */
import { Clock, Effect } from "effect";
import type { ClaimedSlot } from "./channel/server.js";
import { raiseHoldIn } from "./holds.js";
import type { Store, StoreError } from "./store.js";

export const STUCK_WORKER_AFTER_MS = 15 * 60 * 1000;
const unchanged = Symbol("unchanged");
const slotKey = (slot: ClaimedSlot) => JSON.stringify([slot.factoryId, slot.slotId]);

/** Authenticate the injection against an existing attempt, just like a receipt. Duplicate
 * reports must not reset the clock; a held when_idle message has no injection time yet. */
export const recordMessageInjection = (store: Store, slot: ClaimedSlot, id: string): Effect.Effect<boolean, StoreError> =>
  store.change((change) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* change.query<{ id: string }>(
      `UPDATE message_attempt SET injected_at = ? WHERE message_id = ? AND factory_id = ?
       AND slot_id = ? AND launch_id = ? AND injected_at IS NULL AND acknowledged_at IS NULL
       AND EXISTS (SELECT 1 FROM message m WHERE m.id = message_attempt.message_id
         AND m.factory_id = ? AND m.bound_slot = ? AND m.status = 'sent') RETURNING id`,
      [now, id, slot.factoryId, slot.slotId, slot.launchId, slot.factoryId, slot.slotId],
    );

    if (rows.length === 0) {return yield* Effect.fail(unchanged);}

    yield* change.recordHistory({ factoryId: slot.factoryId, kind: "message.injected", subject: id,
      detail: { slotId: slot.slotId, launchId: slot.launchId, injectedAt: now } });

    return true;
  })).pipe(Effect.catchIf((error) => error === unchanged, () => Effect.succeed(false)));

/** Read liveness inside the serialized change, not before waiting for the store writer.
 * An open hold is left alone until a receipt clears it in the acknowledgement transaction. */
export const detectStuckWorkers = (store: Store, isConnected: (slot: ClaimedSlot) => boolean): Effect.Effect<number, StoreError> =>
  store.change((change) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const candidates = yield* change.query<{
      id: string; factory_id: string; bound_slot: string; launch_id: string; injected_at: number;
    }>(`SELECT m.id, m.factory_id, m.bound_slot, a.launch_id, a.injected_at
        FROM message m JOIN message_attempt a ON a.message_id = m.id
        WHERE m.status = 'sent' AND a.acknowledged_at IS NULL AND a.injected_at <= ?
          AND a.factory_id = m.factory_id AND a.slot_id = m.bound_slot
          AND NOT EXISTS (SELECT 1 FROM operator_hold h WHERE h.factory_id = m.factory_id
            AND h.kind = 'stuck_worker' AND h.subject = m.id AND h.state = 'open')`,
    [now - STUCK_WORKER_AFTER_MS]);

    let raised = 0;

    for (const message of candidates) {
      if (!isConnected({ factoryId: message.factory_id, slotId: message.bound_slot, launchId: message.launch_id })) {continue;}

      yield* raiseHoldIn(change, { factoryId: message.factory_id, kind: "stuck_worker", subject: message.id,
        evidence: { messageId: message.id, slot: message.bound_slot, launchId: message.launch_id,
          injectedAt: message.injected_at, unacknowledgedMs: now - message.injected_at } });
      raised++;
    }

    if (raised === 0) {return yield* Effect.fail(unchanged);}

    return raised;
  })).pipe(Effect.catchIf((error) => error === unchanged, () => Effect.succeed(0)));

/** Channel server owns heartbeat deadlines. Lost channels stop qualifying, never imply death.
 * Coalesce periodic work and drain it before the store closes. */
export const startStuckWorkerDetection = (store: Store, onError: (cause: unknown) => void) => {
  const connected = new Map<string, ClaimedSlot>();
  const sweep = () => Effect.runPromise(detectStuckWorkers(store, (slot) => connected.get(slotKey(slot))?.launchId === slot.launchId));
  let running: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (running !== undefined) {return;}

    running = sweep().then(() => {}, onError).finally(() => { running = undefined; });
  }, 1000);

  timer.unref();

  return {
    accepted(slot: ClaimedSlot): void { connected.set(slotKey(slot), slot); },
    lost(slot: ClaimedSlot): void {
      if (connected.get(slotKey(slot))?.launchId === slot.launchId) {connected.delete(slotKey(slot));}
    },
    async stop(): Promise<void> { clearInterval(timer); connected.clear(); await running; },
  };
};
