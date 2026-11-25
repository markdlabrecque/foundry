/** Request deadlines are absolute wall-clock times; downtime never extends them (PRD §6.5). */
import { Clock, Effect } from "effect";
import type { Store, StoreError } from "./store.js";
import { slotRecord, ticketRecord } from "./history-records.js";

const unchanged = Symbol("no expired requests");

/** Close requests and suppress only notices with no attempt, in the same transaction.
 * Attempted copies retain their status/binding and remain acknowledgeable. */
export const expireRequests = (store: Store): Effect.Effect<number, StoreError> =>
  store.change((change) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const requests = yield* change.query<{
      id: string; factory_id: string; notice_id: string; requester_slot: string; ticket_number: number | null; deadline: number;
    }>(`UPDATE agent_request SET status = 'expired' WHERE status = 'open' AND deadline <= ?
        RETURNING id, factory_id, notice_id, requester_slot, ticket_number, deadline`, [now]);

    if (requests.length === 0) {return yield* Effect.fail(unchanged);}

    for (const request of requests) {
      const notices = yield* change.query<{ id: string }>(
        `UPDATE message SET status = 'expired' WHERE id = ? AND status IN ('unbound', 'bound')
         AND NOT EXISTS (SELECT 1 FROM message_attempt WHERE message_id = message.id) RETURNING id`, [request.notice_id],
      );

      const records = [slotRecord(request.requester_slot), ...(request.ticket_number === null ? [] : [ticketRecord(request.ticket_number)])];

      if (notices.length > 0) {
        yield* change.recordHistory({ factoryId: request.factory_id, kind: "message.expired", subject: request.notice_id,
          detail: { requestId: request.id }, records });
      }

      yield* change.recordHistory({ factoryId: request.factory_id, kind: "request.expired", subject: request.id,
        detail: { deadline: request.deadline }, records });
    }

    return requests.length;
  })).pipe(Effect.catchIf((error) => error === unchanged, () => Effect.succeed(0)));

/** The first sweep must finish before workers can send. Coalesce ticks and drain on shutdown. */
export const startRequestExpiry = async (store: Store, onError: (cause: unknown) => void): Promise<() => Promise<void>> => {
  await Effect.runPromise(expireRequests(store));
  let running: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (running !== undefined) {return;}

    running = Effect.runPromise(expireRequests(store)).then(() => {}, onError).finally(() => { running = undefined; });
  }, 1000);

  timer.unref();

  return async () => { clearInterval(timer); await running; };
};
