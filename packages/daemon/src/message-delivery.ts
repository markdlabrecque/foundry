/** Initial delivery only (PRD §6.3). Previously sent messages wait for reconciliation,
 * never blind replay. A sent attempt means recorded for sending, not socket receipt. */
import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import type { Message } from "@foundry/protocol";
import type { AcceptedConnection, ClaimedSlot } from "./channel/server.js";
import { closeOpenHoldIn } from "./holds.js";
import { releaseResumeReplacement } from "./resume-notice.js";
import type { SlotGate } from "./freeze.js";
import type { Store, StoreError } from "./store.js";

const unchanged = Symbol("unchanged");

/** A receipt can acknowledge only an attempt made to this authenticated launch and slot.
 * Duplicates, unsent IDs and cross-slot receipts are inert. */
export const acknowledgeMessage = (store: Store, slot: ClaimedSlot, id: string, reconciledHistory = false): Effect.Effect<boolean, StoreError> =>
  store.change((change) => Effect.gen(function* () {
    const rows = yield* change.query<{ id: string }>(
      `SELECT a.id FROM message_attempt a JOIN message m ON m.id = a.message_id
       WHERE m.id = ? AND m.factory_id = ? AND m.bound_slot = ? AND m.status = 'sent'
         AND (a.launch_id = ? OR ? = 1) AND a.slot_id = ? ORDER BY a.sent_at DESC LIMIT 1`,
      [id, slot.factoryId, slot.slotId, slot.launchId, reconciledHistory ? 1 : 0, slot.slotId],
    );

    const attempt = rows[0];

    if (attempt === undefined) {return yield* Effect.fail(unchanged);}

    const now = yield* Clock.currentTimeMillis;
    yield* change.query(`UPDATE message SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?`, [now, id]);
    yield* change.query(`UPDATE message_attempt SET acknowledged_at = ? WHERE id = ?`, [now, attempt.id]);
    yield* releaseResumeReplacement(change, id, 'acknowledged');
    yield* closeOpenHoldIn(change, { factoryId: slot.factoryId, kind: "stuck_worker", subject: id }, "cleared");
    yield* change.recordHistory({ factoryId: slot.factoryId, kind: "message.acknowledged", subject: id,
      detail: { attemptId: attempt.id, slotId: slot.slotId, launchId: slot.launchId } });

    return true;
  })).pipe(Effect.catchIf((error) => error === unchanged, () => Effect.succeed(false)));

interface BoundMessage {
  readonly id: string;
  readonly body: string;
  readonly delivery: Message["delivery"];
}

/** One serialized pump for each connection, woken by commits rather than a timer. Call attach
 * only after reconciliation/priming permits work, with the primer's guarded writer. */
export const createMessageDelivery = (options: {
  readonly store: Store;
  readonly gate: SlotGate;
  readonly inScope?: (factoryId: string) => boolean;
  readonly onError: (cause: unknown) => void;
}) => {
  const live = new Set<{ schedule: () => void; stop: () => void; idle: () => Promise<void> }>();
  let stopped = false;
  const wake = () => { for (const connection of live) {connection.schedule();} };
  const unsubscribe = options.store.onCommit(wake);
  const unfreeze = options.gate.onUnfrozen(wake);

  return {
    attach(slot: ClaimedSlot, connection: AcceptedConnection): void {
      if (stopped) {return;}

      const connectionId = randomUUID();
      let ended = false;
      let pending = false;
      let running: Promise<void> | undefined;

      const pass = async () => {
        if (options.gate.isFrozen(slot) || options.inScope?.(slot.factoryId) === false) {return;}

        const messages = await Effect.runPromise(options.store.read<BoundMessage>(
          `SELECT id, body, delivery FROM message WHERE factory_id = ? AND bound_slot = ? AND status = 'bound' ORDER BY sequence`,
          [slot.factoryId, slot.slotId],
        ));

        for (const message of messages) {
          if (ended || stopped || options.gate.isFrozen(slot) || options.inScope?.(slot.factoryId) === false) {return;}

          const recorded = await Effect.runPromise(options.store.change((change) => Effect.gen(function* () {
            // Check inside the attempt transaction: the deadline may pass between sweeps,
            // or while this pump waits for the store writer. Never send that first copy.
            const now = yield* Clock.currentTimeMillis;
            // A proven retry or explicit slot reset can re-arm an attempted notice. Supersede
            // that old payload before another attempt, using its deferred replacement content.
            const replacement = yield* releaseResumeReplacement(change, message.id, 'bound');

            if (replacement !== null) {return null;}

            const updated = yield* change.query<BoundMessage>(
              `UPDATE message SET status = 'sent' WHERE id = ? AND status = 'bound'
               AND NOT EXISTS (SELECT 1 FROM agent_request r WHERE r.notice_id = message.id
                 AND (r.status = 'expired' OR r.deadline <= ?))
               AND NOT EXISTS (SELECT 1 FROM resume_notice n JOIN assignment a ON a.id = n.assignment_id
                 WHERE n.message_id = message.id AND (a.status != 'active' OR a.slot_id != message.bound_slot))
               RETURNING id, body, delivery`, [message.id, now],
            );

            if (updated.length === 0) {return yield* Effect.fail(unchanged);}

            // Attribute context to the conversation that actually receives it, including a
            // slot first launched after acceptance or reset before its first delivery.
            yield* change.query(
              `UPDATE repository_context SET conversation_ref = (
                 SELECT ref FROM conversation WHERE factory_id = ? AND slot_id = ? AND status = 'current'
               ) WHERE message_id = ?`,
              [slot.factoryId, slot.slotId, message.id],
            );

            const attemptId = randomUUID();
            yield* change.query(
              `INSERT INTO message_attempt (id, factory_id, message_id, slot_id, launch_id, connection_id, sent_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [attemptId, slot.factoryId, message.id, slot.slotId, slot.launchId, connectionId, now],
            );
            yield* change.recordHistory({ factoryId: slot.factoryId, kind: "message.sent", subject: message.id,
              detail: { attemptId, slotId: slot.slotId, launchId: slot.launchId, connectionId } });

            return updated[0] ?? null;
          })).pipe(Effect.catchIf((error) => error === unchanged, () => Effect.succeed(null))));

          if (recorded && !ended && !stopped) {
            await connection.send({ type: "message", ...recorded });
          }
        }
      };

      const schedule = () => {
        if (ended || stopped) {return;}

        pending = true;

        if (running !== undefined) {return;}

        running = Promise.resolve().then(async () => {
          while (pending && !ended && !stopped) {
            pending = false;

            try {await pass();}
            catch (cause) { ended = true; options.onError(cause); }
          }
        }).finally(() => {
          running = undefined;

          if (pending && !ended && !stopped) {schedule();}
        });
      };

      const entry = { schedule, stop: () => { ended = true; }, idle: async () => { await running; } };
      live.add(entry);
      void connection.closed?.then(() => { entry.stop(); live.delete(entry); });
      schedule();
    },
    async idle(): Promise<void> { await Promise.all([...live].map((entry) => entry.idle())); },
    async stop(): Promise<void> {
      stopped = true;
      unsubscribe();
      unfreeze();

      for (const entry of live) {entry.stop();}

      await Promise.all([...live].map((entry) => entry.idle()));
      live.clear();
    },
  };
};
