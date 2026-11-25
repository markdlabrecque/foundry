/** PRD §6.3 comparison and evidence-gated retry. Channel loss is never death evidence. */
import { randomUUID } from "node:crypto";
import { Clock, Data, Effect } from "effect";
import type { DaemonFrame, Hello, ReconciliationAnswer } from "@foundry/protocol";
import type { AcceptedConnection, ClaimedSlot } from "./channel/server.js";
import type { Store } from "./store.js";
import { acknowledgeMessage } from "./message-delivery.js";
import { actionableMessage } from "./message-obligations.js";
import { composeResumeNotice, releaseResumeReplacement } from "./resume-notice.js";
import { decideMessageRetry } from "./message-retry.js";
import type { RetryDecision, RetryEvidence } from "./message-retry.js";
import { acknowledgePrime } from "./priming.js";

export interface ReconciliationResult {
  /** Work already delivered before this connection began reconciliation, if any. */
  readonly interruptedAssignmentId?: string;
  readonly history: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
  readonly absent: ReadonlyArray<string>;
}

class RetryUnchanged extends Data.TaggedError("RetryUnchanged")<{ readonly decision: RetryDecision }> {}

class RecoveryNoticeUnchanged extends Data.TaggedError("RecoveryNoticeUnchanged") {}

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

      // Pin the work being recovered before any asynchronous history/priming exchange.
      // Undelivered assignment context is ordinary new work, not an interruption.
      const [interrupted] = await Effect.runPromise(store.read<{ id: string }>(
        `SELECT a.id FROM assignment a JOIN message m ON m.id = a.context_message
         WHERE a.factory_id = ? AND a.slot_id = ? AND a.status = 'active'
           AND (m.status = 'acknowledged' OR EXISTS (SELECT 1 FROM message_attempt ma WHERE ma.message_id = m.id))`,
        [slot.factoryId, slot.slotId],
      ));

      const rows = await Effect.runPromise(store.read<{ id: string }>(
        `SELECT m.id FROM message m WHERE m.factory_id = ? AND m.bound_slot = ? AND m.status = 'sent'
           AND EXISTS (SELECT 1 FROM message_attempt a WHERE a.message_id = m.id AND a.slot_id = ?)
         UNION SELECT id FROM prime WHERE factory_id = ? AND slot_id = ? AND conversation_ref = ? AND acknowledged_at IS NULL`,
        [slot.factoryId, slot.slotId, slot.slotId, slot.factoryId, slot.slotId, hello.conversationRef],
      ));

      const statuses = new Map<string, "history" | "pending" | "absent">();
      let ids = rows.map((row) => row.id);
      let whenIdle = false;

      while (ids.length > 0) {
        if (ended) {throw new Error("channel ended during reconciliation");}

        const requestId = randomUUID();

        const answer = new Promise<ReconciliationAnswer>((resolve, reject) => {
          rejectClosed = reject;
          waiting.set(requestId, { slot, ids: new Set(ids), resolve });
        });

        // Observe closure even while a channel write is in flight.
        void answer.catch(() => {});

        try {
          const request: Extract<DaemonFrame, { type: "reconcile" }> = whenIdle
            ? { type: "reconcile", requestId, ids, whenIdle: true }
            : { type: "reconcile", requestId, ids };

          await connection.send(request);
          const response = await answer;
          const recheck: Array<string> = [];

          for (const item of response.answers) {
            if (ended) {throw new Error("channel ended during reconciliation");}

            statuses.set(item.id, item.status);

            if (item.status === "history") {
              const prime = await Effect.runPromise(acknowledgePrime(store, { ...slot, id: item.id }));

              if (prime === "unknown") {await Effect.runPromise(acknowledgeMessage(store, slot, item.id, true));}
            } else if (item.status === "absent") {
              // Decide and re-arm in one transaction. Missing launch rows and unended old
              // launches fail closed; only the host-backed launch ledger proves replacement.
              const decision = await Effect.runPromise(store.change((change) => Effect.gen(function* () {
                const attempts = yield* change.query<{ launch_id: string; ended_at: number | null }>(
                  `SELECT a.launch_id, l.ended_at FROM message_attempt a
                   LEFT JOIN launch l ON l.launch_id = a.launch_id AND l.factory_id = a.factory_id AND l.slot_id = a.slot_id
                   WHERE a.message_id = ? AND a.factory_id = ? AND a.slot_id = ?`,
                  [item.id, slot.factoryId, slot.slotId],
                );

                // Primes have their own recovery-prime lifecycle, not message delivery.
                if (attempts.length === 0) {return yield* Effect.fail(new RetryUnchanged({ decision: "indeterminate" }));}

                const oldCopiesGone = attempts.every((attempt) => attempt.launch_id === slot.launchId || attempt.ended_at !== null);

                const launch: RetryEvidence["launch"] = !oldCopiesGone ? "unknown"
                  : attempts.some((attempt) => attempt.launch_id === slot.launchId) ? "same"
                    : hello.hasRecoverableHistory ? "replacement" : "unknown";

                const decided = decideMessageRetry({ status: item.status, launch, lifecycle: response.lifecycle ?? "unknown" });

                if (decided !== "retry" || ended) {return yield* Effect.fail(new RetryUnchanged({ decision: decided }));}

                // Absence evidence retires copies independently of permission to replay work.
                // Abandoned messages stay sent/acknowledgeable, but their proven-gone clocks
                // must not produce stuck-worker holds. Pending/unknown copies never reach here.
                const retiredAt = yield* Clock.currentTimeMillis;

                const retired = yield* change.query<{ id: string }>(`UPDATE message_attempt SET retired_at = ?
                  WHERE message_id = ? AND factory_id = ? AND slot_id = ? AND retired_at IS NULL
                  AND EXISTS (SELECT 1 FROM message m WHERE m.id = message_attempt.message_id
                    AND m.factory_id = ? AND m.bound_slot = ? AND m.status = 'sent') RETURNING id`,
                [retiredAt, item.id, slot.factoryId, slot.slotId, slot.factoryId, slot.slotId]);

                const replacement = yield* releaseResumeReplacement(change, item.id, 'sent');

                if (replacement !== null) {return decided;}

                const updated = yield* change.query<{ id: string }>(
                  `UPDATE message SET status = 'bound' WHERE id = ? AND factory_id = ? AND bound_slot = ? AND status = 'sent'
                   AND ${actionableMessage} RETURNING id`,
                  [item.id, slot.factoryId, slot.slotId],
                );

                if (updated.length === 0 && retired.length === 0) {return yield* Effect.fail(new RetryUnchanged({ decision: decided }));}

                yield* change.recordHistory({ factoryId: slot.factoryId,
                  kind: updated.length > 0 ? "message.retry_ready" : "message.copies_retired", subject: item.id,
                  detail: { slotId: slot.slotId, launchId: slot.launchId, launch, lifecycle: response.lifecycle ?? "unknown" } });

                return decided;
              })).pipe(Effect.catchTag("RetryUnchanged", (cause) => Effect.succeed(cause.decision))));

              // An old peer that ignores whenIdle must not create a busy request loop.
              if (decision === "recheck_when_idle" && !whenIdle) {recheck.push(item.id);}
            }
          }

          ids = recheck;
          whenIdle = true;
        } finally {
          waiting.delete(requestId);
          rejectClosed = undefined;
        }
      }

      if (ended) {throw new Error("channel ended during reconciliation");}

      const result: MutableResult = { history: [], pending: [], absent: [] };

      for (const [id, status] of statuses) {result[status].push(id);}

      return interrupted === undefined ? result : { ...result, interruptedAssignmentId: interrupted.id };
    },
    /** After successful priming, take a fresh lifecycle snapshot. A prime never starts a
     * turn; only an idle worker still holding active work needs a continuation notice.
     * Do not wait for a working worker to settle: its accepted outcome must stand. */
    async resumeAssignment(slot: ClaimedSlot, connection: AcceptedConnection, assignmentId: string | undefined): Promise<string | null> {
      if (assignmentId === undefined) {return null;}

      const requestId = randomUUID();
      let ended = false;
      let rejectClosed: ((cause: Error) => void) | undefined;
      void connection.closed?.then(() => {
        ended = true;
        rejectClosed?.(new Error("channel ended during recovery notice comparison"));
      });

      const answer = new Promise<ReconciliationAnswer>((resolve, reject) => {
        rejectClosed = reject;
        waiting.set(requestId, { slot, ids: new Set(), resolve });
      });

      void answer.catch(() => {});

      try {
        await connection.send({ type: "reconcile", requestId, ids: [] });
        const response = await answer;

        if (ended || response.lifecycle !== "idle") {return null;}

        return await Effect.runPromise(store.change((change) => Effect.gen(function* () {
          // Read and compose in one transaction, not from a pre-reconciliation assignment
          // snapshot. In particular, a committed task_transition must never be revived.
          const [assignment] = yield* change.query<{
            id: string; ticket_number: number; stage: string; station: string;
          }>(`SELECT a.id, a.ticket_number, a.stage, s.station FROM assignment a
            JOIN slot s ON s.factory_id = a.factory_id AND s.slot_id = a.slot_id
            JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
            WHERE a.factory_id = ? AND a.slot_id = ? AND a.id = ? AND a.status = 'active'
              AND s.current_launch = ? AND s.condition = 'normal'
              AND t.state = 'stage' AND t.status = 'assigned' AND t.stage = a.stage`,
          [slot.factoryId, slot.slotId, assignmentId, slot.launchId]);

          if (ended || assignment === undefined) {return yield* new RecoveryNoticeUnchanged();}

          return yield* composeResumeNotice(change, {
            assignmentId: assignment.id, factoryId: slot.factoryId, ticket: assignment.ticket_number,
            stage: assignment.stage, slotId: slot.slotId, recipient: assignment.station,
          });
        })).pipe(Effect.catchTag("RecoveryNoticeUnchanged", () => Effect.succeed(null))));
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
