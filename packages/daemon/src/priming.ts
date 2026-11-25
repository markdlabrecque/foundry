/**
 * Sending the fresh prime and recording its receipt (PRD §5.5, §10.1).
 *
 * On an accepted connection the daemon decides from its own records whether a
 * fresh prime is due, records it (situation and path-and-hash list) with a
 * history row, and only then writes the `prime` frame. Work frames sent on the
 * same connection wait behind it, but never for its receipt. A receipt from
 * the worker marks the prime acknowledged in the same transaction as its
 * history row.
 *
 * Out of scope here: recovery and compaction primes (41b, 38b) and freezing on
 * a missing instruction file (11c). Those situations are reported as outcomes
 * and nothing is sent.
 */
import { randomUUID } from "node:crypto";
import { Clock, Data, Effect } from "effect";
import type { DaemonFrame, Hello } from "@foundry/protocol";
import type { AcceptedConnection, ClaimedSlot } from "./channel/server.js";
import {
  composePrime,
  type ComposePrimeResult,
  type PrimeRequest,
  type PrimeSourceProblem,
  type Situation,
} from "./prime.js";
import type { Store, StoreError } from "./store.js";

/** What the daemon records about each composed part: never its content. */
export interface PrimePartRecord {
  readonly source: string;
  readonly hash: string;
}

export interface PrimeRecord {
  readonly id: string;
  readonly factoryId: string;
  readonly slotId: string;
  readonly launchId: string;
  readonly conversationRef: string;
  readonly situation: Situation;
  readonly parts: ReadonlyArray<PrimePartRecord>;
  /** Wall-clock ms when the daemon recorded the prime, just before sending it. */
  readonly recordedAt: number;
  /** Wall-clock ms of the receipt, or `null` while unacknowledged. */
  readonly acknowledgedAt: number | null;
}

export type NewPrimeRecord = Omit<PrimeRecord, "recordedAt" | "acknowledgedAt">;

interface PrimeRow {
  id: string;
  factory_id: string;
  slot_id: string;
  launch_id: string;
  conversation_ref: string;
  situation: Situation;
  parts: string;
  recorded_at: number;
  acknowledged_at: number | null;
}

const fromRow = (row: PrimeRow): PrimeRecord => ({
  id: row.id,
  factoryId: row.factory_id,
  slotId: row.slot_id,
  launchId: row.launch_id,
  conversationRef: row.conversation_ref,
  situation: row.situation,
  parts: JSON.parse(row.parts) as PrimePartRecord[],
  recordedAt: row.recorded_at,
  acknowledgedAt: row.acknowledged_at,
});

/** Record a prime the daemon is about to send, unacknowledged, with its `prime.sent` history row. */
export const recordPrime = (store: Store, prime: NewPrimeRecord): Effect.Effect<number, StoreError> =>
  store.change(({ query, recordHistory }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const parts = prime.parts.map(({ source, hash }) => ({ source, hash }));
      yield* query(
        `INSERT INTO prime (id, factory_id, slot_id, launch_id, conversation_ref, situation, parts, recorded_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [prime.id, prime.factoryId, prime.slotId, prime.launchId, prime.conversationRef, prime.situation, JSON.stringify(parts), now],
      );
      return yield* recordHistory({
        factoryId: prime.factoryId,
        kind: "prime.sent",
        subject: prime.slotId,
        detail: {
          primeId: prime.id,
          launchId: prime.launchId,
          conversationRef: prime.conversationRef,
          situation: prime.situation,
          parts,
        },
      });
    }),
  );

/** The primes recorded for one slot's conversation, oldest first. */
export const primesForConversation = (
  store: Store,
  factoryId: string,
  slotId: string,
  conversationRef: string,
): Effect.Effect<ReadonlyArray<PrimeRecord>, StoreError> =>
  store
    .read<PrimeRow>(
      `SELECT * FROM prime WHERE factory_id = ? AND slot_id = ? AND conversation_ref = ? ORDER BY recorded_at, rowid`,
      [factoryId, slotId, conversationRef],
    )
    .pipe(Effect.map((rows) => rows.map(fromRow)));

export type AcknowledgeOutcome = "acknowledged" | "duplicate" | "unknown";

class NothingToAcknowledge extends Data.TaggedError("NothingToAcknowledge")<{
  readonly outcome: Exclude<AcknowledgeOutcome, "acknowledged">;
}> {}

/**
 * Record a worker's receipt for a prime of its own slot. A repeated receipt,
 * or one for an ID that is not a prime of that slot, changes nothing.
 */
export const acknowledgePrime = (
  store: Store,
  receipt: { readonly factoryId: string; readonly slotId: string; readonly id: string },
): Effect.Effect<AcknowledgeOutcome, StoreError> =>
  store
    .change(({ query, recordHistory }) =>
      Effect.gen(function* () {
        const rows = yield* query<{ acknowledged_at: number | null }>(
          `SELECT acknowledged_at FROM prime WHERE id = ? AND factory_id = ? AND slot_id = ?`,
          [receipt.id, receipt.factoryId, receipt.slotId],
        );
        const row = rows[0];
        if (row === undefined) return yield* new NothingToAcknowledge({ outcome: "unknown" });
        if (row.acknowledged_at !== null) return yield* new NothingToAcknowledge({ outcome: "duplicate" });
        const now = yield* Clock.currentTimeMillis;
        yield* query(`UPDATE prime SET acknowledged_at = ? WHERE id = ?`, [now, receipt.id]);
        yield* recordHistory({
          factoryId: receipt.factoryId,
          kind: "prime.acknowledged",
          subject: receipt.slotId,
          detail: { primeId: receipt.id },
        });
        return "acknowledged" as const;
      }),
    )
    .pipe(Effect.catchTag("NothingToAcknowledge", (e) => Effect.succeed(e.outcome)));

/**
 * What an accepted connection needs, from the daemon's records only (§5.5):
 * - `reconnect`: a prime was already sent to this launch, so none is sent.
 * - `not_fresh`: a prime was acknowledged for this conversation and the launch is new (recovery, 41b).
 * - `fresh`: no prime has been acknowledged for this conversation.
 */
export const decideFreshPriming = (
  primes: ReadonlyArray<PrimeRecord>,
  launchId: string,
): "fresh" | "reconnect" | "not_fresh" => {
  if (primes.some((p) => p.launchId === launchId)) return "reconnect";
  if (primes.some((p) => p.acknowledgedAt !== null)) return "not_fresh";
  return "fresh";
};

export type PrimingOutcome =
  /** The fresh prime was recorded and written to the connection. */
  | { readonly _tag: "Sent"; readonly primeId: string }
  /** A reconnect from the same launch: no prime. */
  | { readonly _tag: "Reconnect" }
  /** A recovery prime is due; sending it belongs to 41b. Nothing was sent. */
  | { readonly _tag: "NotFresh" }
  /** No effective station is known for the slot. Nothing was sent. */
  | { readonly _tag: "UnknownStation" }
  /** An instruction file could not be read; freezing belongs to 11c. Nothing was recorded or sent. */
  | { readonly _tag: "SourceUnavailable"; readonly problems: ReadonlyArray<PrimeSourceProblem> }
  /** Recorded, but the write failed; the record stays unacknowledged. */
  | { readonly _tag: "SendFailed"; readonly primeId: string; readonly error: unknown };

/** Outcomes after which work frames may follow on the connection. */
const opensConnection = (outcome: PrimingOutcome): boolean => outcome._tag === "Sent" || outcome._tag === "Reconnect";

export interface PrimerOptions {
  readonly store: Store;
  /** The slot's prime inputs (from its effective station), without the situation. */
  readonly primeRequest: (slot: ClaimedSlot) => Omit<PrimeRequest, "situation"> | undefined;
  /** Defaults to `composePrime`. */
  readonly compose?: (request: PrimeRequest) => Promise<ComposePrimeResult>;
  /** Defaults to a random UUID. */
  readonly newPrimeId?: () => string;
}

export interface PrimedConnection {
  /** Settles once priming for this connection is decided and, if due, the prime written. */
  readonly outcome: Promise<PrimingOutcome>;
  /**
   * The connection for every later frame. Sends wait behind the prime (never
   * for its receipt) and are refused if priming did not complete.
   */
  readonly connection: AcceptedConnection;
}

export interface Primer {
  /** Call from `onAccepted`, after the slot claim has reconciled the hello. */
  prime(slot: ClaimedSlot, hello: Hello, connection: AcceptedConnection): PrimedConnection;
  /** Call for each `receipt` frame from the slot's accepted connection. */
  receipt(slot: ClaimedSlot, id: string): Promise<AcknowledgeOutcome>;
}

export const createPrimer = (options: PrimerOptions): Primer => {
  const compose = options.compose ?? ((request: PrimeRequest) => composePrime(request));
  const newPrimeId = options.newPrimeId ?? (() => `prime-${randomUUID()}`);
  const run = <A>(effect: Effect.Effect<A, StoreError>): Promise<A> => Effect.runPromise(effect);

  const decideAndSend = async (slot: ClaimedSlot, hello: Hello, connection: AcceptedConnection): Promise<PrimingOutcome> => {
    const primes = await run(primesForConversation(options.store, slot.factoryId, slot.slotId, hello.conversationRef));
    const decision = decideFreshPriming(primes, slot.launchId);
    if (decision === "reconnect") return { _tag: "Reconnect" };
    if (decision === "not_fresh") return { _tag: "NotFresh" };

    const request = options.primeRequest(slot);
    if (request === undefined) return { _tag: "UnknownStation" };
    const composed = await compose({ ...request, situation: "fresh" });
    if (composed._tag === "SourceUnavailable") return composed;

    const primeId = newPrimeId();
    // Recorded before it is written, so a prime that reaches the worker is always on record.
    await run(
      recordPrime(options.store, {
        id: primeId,
        factoryId: slot.factoryId,
        slotId: slot.slotId,
        launchId: slot.launchId,
        conversationRef: hello.conversationRef,
        situation: "fresh",
        parts: composed.prime.parts,
      }),
    );
    try {
      await connection.send({ type: "prime", id: primeId, text: composed.prime.text });
    } catch (error) {
      return { _tag: "SendFailed", primeId, error };
    }
    return { _tag: "Sent", primeId };
  };

  return {
    prime(slot, hello, connection) {
      const outcome = decideAndSend(slot, hello, connection);
      const gate = outcome.then((settled) => {
        if (!opensConnection(settled)) throw new Error(`priming did not complete: ${settled._tag}`);
      });
      gate.catch(() => {}); // observed by each send below
      let queue: Promise<unknown> = gate;
      return {
        outcome,
        connection: {
          send: (frame: DaemonFrame) => {
            const sent = queue.then(() => connection.send(frame));
            queue = sent.catch(() => {});
            return sent;
          },
        },
      };
    },
    receipt: (slot, id) =>
      run(acknowledgePrime(options.store, { factoryId: slot.factoryId, slotId: slot.slotId, id })),
  };
};
