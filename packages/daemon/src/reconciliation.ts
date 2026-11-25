/** PRD §6.3 comparison only. Absence is exposed, never treated as permission to replay. */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Hello, ReconciliationAnswer } from "@foundry/protocol";
import type { AcceptedConnection, ClaimedSlot } from "./channel/server.js";
import type { Store } from "./store.js";
import { acknowledgeMessage } from "./message-delivery.js";
import { acknowledgePrime } from "./priming.js";

export interface ReconciliationResult {
  readonly history: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
  readonly absent: ReadonlyArray<string>;
}

interface MutableResult {
  history: Array<string>;
  pending: Array<string>;
  absent: Array<string>;
}

interface Comparison {
  readonly slot: ClaimedSlot;
  readonly ids: ReadonlySet<string>;
  readonly resolve: (answer: ReconciliationAnswer) => void;
}

export const createReconciler = (store: Store) => {
  const waiting = new Map<string, Comparison>();

  return {
    async reconcile(slot: ClaimedSlot, hello: Hello, connection: AcceptedConnection): Promise<ReconciliationResult> {
      let ended = false;
      let rejectClosed: ((cause: Error) => void) | undefined;
      void connection.closed?.then(() => {
        ended = true;
        rejectClosed?.(new Error("channel ended during reconciliation"));
      });

      const rows = await Effect.runPromise(store.read<{ id: string }>(
        `SELECT m.id FROM message m WHERE m.factory_id = ? AND m.bound_slot = ? AND m.status = 'sent'
           AND EXISTS (SELECT 1 FROM message_attempt a WHERE a.message_id = m.id AND a.slot_id = ?)
         UNION SELECT id FROM prime WHERE factory_id = ? AND slot_id = ? AND conversation_ref = ? AND acknowledged_at IS NULL`,
        [slot.factoryId, slot.slotId, slot.slotId, slot.factoryId, slot.slotId, hello.conversationRef],
      ));

      if (ended) {throw new Error("channel ended during reconciliation");}

      const result: MutableResult = { history: [], pending: [], absent: [] };

      if (rows.length === 0) {return result;}

      const requestId = randomUUID();

      const answer = new Promise<ReconciliationAnswer>((resolve, reject) => {
        rejectClosed = reject;
        waiting.set(requestId, { slot, ids: new Set(rows.map((row) => row.id)), resolve });
      });

      // Observe closure even while a channel write is in flight.
      void answer.catch(() => {});

      try {
        await connection.send({ type: "reconcile", requestId, ids: rows.map((row) => row.id) });
        const response = await answer;

        for (const item of response.answers) {
          result[item.status].push(item.id);

          if (item.status !== "history") {continue;}

          const prime = await Effect.runPromise(acknowledgePrime(store, { ...slot, id: item.id }));

          if (prime === "unknown") {await Effect.runPromise(acknowledgeMessage(store, slot, item.id, true));}
        }

        if (ended) {throw new Error("channel ended during reconciliation");}

        return result;
      } finally {
        waiting.delete(requestId);
        rejectClosed = undefined;
      }
    },
    /** Ignore unsolicited, stale, cross-slot, partial and duplicate-ID answers. */
    receive(slot: ClaimedSlot, answer: ReconciliationAnswer): void {
      const comparison = waiting.get(answer.requestId);

      if (!comparison || comparison.slot.factoryId !== slot.factoryId || comparison.slot.slotId !== slot.slotId ||
          comparison.slot.launchId !== slot.launchId || answer.answers.length !== comparison.ids.size) {return;}

      const ids = new Set(answer.answers.map((item) => item.id));

      if (ids.size !== comparison.ids.size || [...ids].some((id) => !comparison.ids.has(id))) {return;}

      waiting.delete(answer.requestId);
      comparison.resolve(answer);
    },
  };
};
