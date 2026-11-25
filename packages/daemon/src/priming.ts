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
 * When the worker reports a compaction, the daemon sends one `compaction`
 * prime on the same connection, ahead of every work frame not yet written; the
 * launch and conversation are kept. The extension injects it without starting
 * a turn, so Pi appends it at the next tool-round boundary.
 *
 * A prime that cannot be composed because an instruction file is missing or
 * unreadable is never sent: given `freeze`, the primer freezes the slot with
 * the `instruction_missing` cause and a hold naming the files (PRD §5.3,
 * §5.5), waits for the operator's unfreeze, and composes the prime afresh.
 *
 * After a compaction prime, an assigned slot receives its full repository context
 * as an ordinary durable message. Recovery primes remain out of scope here (41b).
 */
import { randomUUID } from "node:crypto";
import { Clock, Data, Effect, Schema } from "effect";
import type { DaemonFrame, Hello } from "@foundry/protocol";
import type { AcceptedConnection, ClaimedSlot } from "./channel/server.js";
import { resendAssignmentRepositoryContext } from "./assignment-repository-context.js";
import { ComposePrimeResult, composePrime } from "./prime.js";
import type { PrimeRequest, PrimeSourceProblem, Situation } from "./prime.js";
import type { Store, StoreError } from "./store.js";
import { openSlotGate, whenSendable } from "./freeze.js";
import type { FreezeOutcome, FreezeRequest, SlotGate, SlotRef } from "./freeze.js";
import { instructionMissingEvidence } from "./instruction-freeze.js";

/** What the daemon records about each composed part: never its content. */
export const PrimePartRecord = Schema.Struct({
  source: Schema.String,
  hash: Schema.String,
});

export type PrimePartRecord = typeof PrimePartRecord.Type;

const decodeParts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(PrimePartRecord)));

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
  parts: decodeParts(row.parts),
  recordedAt: row.recorded_at,
  acknowledgedAt: row.acknowledged_at,
});

/**
 * Record a prime the daemon is about to send, unacknowledged, with its
 * `prime.sent` history row. `prime.sent` means "recorded for sending": it is
 * written before the frame, so a crash in between leaves a recorded prime the
 * worker never saw (reconciled by 17a), never a sent prime with no record.
 */
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

        if (row === undefined) {return yield* new NothingToAcknowledge({ outcome: "unknown" });}

        if (row.acknowledged_at !== null) {return yield* new NothingToAcknowledge({ outcome: "duplicate" });}

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
  if (primes.some((p) => p.launchId === launchId)) {return "reconnect";}

  if (primes.some((p) => p.acknowledgedAt !== null)) {return "not_fresh";}

  return "fresh";
};

export type PrimingOutcome = Data.TaggedEnum<{
  /** The fresh prime was recorded and written to the connection. */
  Sent: { readonly primeId: string };
  /**
   * A reconnect from the same launch: no prime. Carries the newest prime sent
   * to this launch that is still unacknowledged, if any, for reconciliation (17a).
   */
  Reconnect: { readonly unacknowledgedPrimeId?: string };
  /** A recovery prime is due; sending it belongs to 41b. Nothing was sent. */
  NotFresh: Record<never, never>;
  /** No effective station is known for the slot. Nothing was sent. */
  UnknownStation: Record<never, never>;
  /**
   * An instruction file could not be read and the slot could not be frozen for it (no `freeze`
   * configured, or no slot record). Nothing was recorded or sent.
   */
  SourceUnavailable: { readonly problems: ReadonlyArray<PrimeSourceProblem> };
  /** Recorded, but the write failed; the record stays unacknowledged. */
  SendFailed: { readonly primeId: string; readonly error: unknown };
  /** The connection ended while its slot was frozen. Nothing was sent; a prime may stay recorded unacknowledged. */
  Closed: Record<never, never>;
}>;

export const PrimingOutcome = Data.taggedEnum<PrimingOutcome>();

const isSent = PrimingOutcome.$is("Sent");

const isReconnect = PrimingOutcome.$is("Reconnect");

/** Outcomes after which work frames may follow on the connection. */
const opensConnection = (outcome: PrimingOutcome): boolean => isSent(outcome) || isReconnect(outcome);

export type CompactionPrimingOutcome = Data.TaggedEnum<{
  /** The compaction prime was recorded and written ahead of every work frame not yet written. */
  Sent: { readonly primeId: string };
  /** No primed connection is known for this launch of the slot. Nothing was sent. */
  NotConnected: Record<never, never>;
  /** The connection's own priming did not complete, so nothing may be written on it. */
  NotPrimed: Record<never, never>;
  /** No effective station is known for the slot. Nothing was sent. */
  UnknownStation: Record<never, never>;
  /**
   * An instruction file could not be read and the slot could not be frozen for it (no `freeze`
   * configured, or no slot record). Nothing was recorded or sent.
   */
  SourceUnavailable: { readonly problems: ReadonlyArray<PrimeSourceProblem> };
  /** Recorded, but the write failed; the record stays unacknowledged. */
  SendFailed: { readonly primeId: string; readonly error: unknown };
}>;

export const CompactionPrimingOutcome = Data.taggedEnum<CompactionPrimingOutcome>();

const isSourceUnavailable = ComposePrimeResult.$is("SourceUnavailable");

interface QueuedFrame {
  readonly frame: DaemonFrame;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

/**
 * Writes one primed connection's frames one at a time, once its priming opens
 * it. A compaction prime goes ahead of every work frame not yet written, and
 * work frames wait while a compaction prime is being prepared.
 */
class PrimedWriter {
  private readonly work: Array<QueuedFrame> = [];
  private readonly first: Array<QueuedFrame> = [];
  private holds = 0;
  private writing = false;
  private state: "pending" | "open" | Error = "pending";
  /** Removes this writer's unfreeze listener; nothing more is written once it is refused. */
  private readonly stopWatching: () => void;
  /** Settles `true` once priming opens the connection, `false` if it never will. */
  readonly opened: Promise<boolean>;

  constructor(
    private readonly connection: AcceptedConnection,
    outcome: Promise<PrimingOutcome>,
    private readonly gate: SlotGate,
    private readonly slot: SlotRef,
  ) {
    // A frozen slot is sent nothing (PRD §5.3); its queued frames stay bound and go out once unfrozen.
    this.stopWatching = gate.onUnfrozen((unfrozen) => {
      if (unfrozen.factoryId === slot.factoryId && unfrozen.slotId === slot.slotId) {this.pump();}
    });

    const ended = () => this.refuse(new Error("channel connection has ended"));
    void connection.closed?.then(ended, ended);
    this.opened = outcome.then(
      (settled) => {
        // The connection ended while priming was decided: it stays refused.
        if (this.state instanceof Error) {return false;}

        if (!opensConnection(settled)) {return this.refuse(new Error(`priming did not complete: ${settled._tag}`));}

        this.state = "open";
        this.pump();

        return true;
      },
      (cause: unknown) => this.refuse(new Error(`priming did not complete: ${String(cause)}`)),
    );
  }

  /** A work frame: written in call order, behind the prime and any compaction prime. */
  send(frame: DaemonFrame): Promise<void> {
    return this.enqueue(this.work, frame);
  }

  /** A compaction prime: written before every work frame not yet written. */
  sendFirst(frame: DaemonFrame): Promise<void> {
    return this.enqueue(this.first, frame);
  }

  /** Hold work frames until the returned release is called. */
  hold(): () => void {
    this.holds += 1;
    let released = false;

    return () => {
      if (released) {return;}

      released = true;
      this.holds -= 1;
      this.pump();
    };
  }

  private enqueue(queue: Array<QueuedFrame>, frame: DaemonFrame): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.state instanceof Error) {
        reject(this.state);

        return;
      }

      queue.push({ frame, resolve, reject });
      this.pump();
    });
  }

  private refuse(error: Error): false {
    this.state = error;
    this.stopWatching();

    for (const queued of [...this.first.splice(0), ...this.work.splice(0)]) {queued.reject(error);}

    return false;
  }

  private pump(): void {
    if (this.state !== "open" || this.writing || this.gate.isFrozen(this.slot)) {return;}

    const next = this.first.shift() ?? (this.holds === 0 ? this.work.shift() : undefined);

    if (next === undefined) {return;}

    this.writing = true;
    void this.connection
      .send(next.frame)
      .then(next.resolve, next.reject)
      .then(() => {
        this.writing = false;
        this.pump();
      });
  }
}

export interface PrimerOptions {
  readonly store: Store;
  /** The slot's prime inputs (from its effective station), without the situation. */
  readonly primeRequest: (slot: ClaimedSlot) => Omit<PrimeRequest, "situation"> | undefined;
  /** Defaults to `composePrime`. */
  readonly compose?: (request: PrimeRequest) => Promise<ComposePrimeResult>;
  /** Defaults to a random UUID. */
  readonly newPrimeId?: () => string;
  /** Factory default-branch checkout; enables repository context restoration after compaction. */
  readonly clonePath?: (factoryId: string) => string;
  /**
   * Frozen slots (PRD §5.3): nothing is written to one, the prime included, until it is unfrozen.
   * Defaults to a gate that holds nothing back.
   */
  readonly gate?: SlotGate;
  /**
   * Freezes a slot whose prime cannot be composed (PRD §5.5): pass the freezer that backs `gate`.
   * Without it a missing instruction file ends priming with `SourceUnavailable`.
   */
  readonly freeze?: (request: FreezeRequest) => Promise<FreezeOutcome>;
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
  /**
   * Call for each `compacted` frame from the slot's accepted connection. Sends
   * one `compaction` prime on the launch's latest primed connection, ahead of
   * every work frame not yet written. Work frames sent from this call on wait
   * until the prime is written or the attempt ends. No new launch is started.
   * Rejects, like `prime().outcome`, if composing or recording fails.
   */
  compacted(slot: ClaimedSlot): Promise<CompactionPrimingOutcome>;
}

const run = <A>(effect: Effect.Effect<A, StoreError>): Promise<A> => Effect.runPromise(effect);

const slotKey = (slot: ClaimedSlot): string => JSON.stringify([slot.factoryId, slot.slotId]);

export const createPrimer = (options: PrimerOptions): Primer => {
  const compose = options.compose ?? ((request: PrimeRequest) => composePrime(request));
  const newPrimeId = options.newPrimeId ?? (() => `prime-${randomUUID()}`);
  const gate = options.gate ?? openSlotGate;
  // Decide-and-send runs one at a time per slot, so two hellos from one launch
  // cannot both read "no prime yet" and both send a fresh prime.
  const slotTurns = new Map<string, Promise<unknown>>();

  // The latest primed connection per slot, where a compaction prime is written.
  const live = new Map<
    string,
    { readonly launchId: string; readonly conversationRef: string; readonly writer: PrimedWriter; readonly closed: Promise<void> | undefined }
  >();

  const serialized = <A>(slot: ClaimedSlot, task: () => Promise<A>): Promise<A> => {
    const key = slotKey(slot);
    const previous = slotTurns.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);

    const settled = next.then(
      () => {},
      () => {},
    );

    slotTurns.set(key, settled);
    void settled.then(() => {
      if (slotTurns.get(key) === settled) {slotTurns.delete(key);}
    });

    return next;
  };

  /** Freezes the slot for its unreadable instruction files; `false` when it could not be frozen. */
  const freezeForMissing = async (slot: ClaimedSlot, problems: ReadonlyArray<PrimeSourceProblem>): Promise<boolean> =>
    options.freeze !== undefined &&
    (await options.freeze({
      factoryId: slot.factoryId,
      slotId: slot.slotId,
      cause: "instruction_missing",
      evidence: instructionMissingEvidence(problems),
    })) === "frozen";

  const decideAndSend = async (slot: ClaimedSlot, hello: Hello, connection: AcceptedConnection): Promise<PrimingOutcome> => {
    const primes = await run(primesForConversation(options.store, slot.factoryId, slot.slotId, hello.conversationRef));
    const decision = decideFreshPriming(primes, slot.launchId);

    if (decision === "reconnect") {
      const unacknowledged = primes.filter((p) => p.launchId === slot.launchId && p.acknowledgedAt === null).at(-1);

      return unacknowledged === undefined
        ? PrimingOutcome.Reconnect({})
        : PrimingOutcome.Reconnect({ unacknowledgedPrimeId: unacknowledged.id });
    }

    if (decision === "not_fresh") {return PrimingOutcome.NotFresh();}

    const request = options.primeRequest(slot);

    if (request === undefined) {return PrimingOutcome.UnknownStation();}

    const composed = await compose({ ...request, situation: "fresh" });

    if (isSourceUnavailable(composed)) {
      // PRD §5.5: the prime fails and the slot freezes. Once unfrozen, priming is decided afresh.
      if (!(await freezeForMissing(slot, composed.problems))) {return composed;}

      return (await whenSendable(gate, slot, connection.closed)) ? decideAndSend(slot, hello, connection) : PrimingOutcome.Closed();
    }

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

    // The slot may have been frozen while the prime was composed and recorded: it waits for the
    // unfreeze, and nothing is awaited between this check and the write. A connection that ends
    // first leaves the record unacknowledged, as a failed send does.
    if (gate.isFrozen(slot) && !(await whenSendable(gate, slot, connection.closed))) {return PrimingOutcome.Closed();}

    try {
      await connection.send({ type: "prime", id: primeId, text: composed.prime.text });
    } catch (error) {
      return PrimingOutcome.SendFailed({ primeId, error });
    }

    return PrimingOutcome.Sent({ primeId });
  };

  const sendCompactionPrime = async (
    slot: ClaimedSlot,
    conversationRef: string,
    writer: PrimedWriter,
    closed: Promise<void> | undefined,
  ): Promise<CompactionPrimingOutcome> => {
    if (!(await writer.opened)) {return CompactionPrimingOutcome.NotPrimed();}

    const request = options.primeRequest(slot);

    if (request === undefined) {return CompactionPrimingOutcome.UnknownStation();}

    const composed = await compose({ ...request, situation: "compaction" });

    if (isSourceUnavailable(composed)) {
      // Work frames stay held behind the compaction prime while the slot is frozen for its files.
      if (!(await freezeForMissing(slot, composed.problems))) {return composed;}

      return (await whenSendable(gate, slot, closed))
        ? sendCompactionPrime(slot, conversationRef, writer, closed)
        : CompactionPrimingOutcome.NotConnected();
    }

    const primeId = newPrimeId();
    await run(
      recordPrime(options.store, {
        id: primeId,
        factoryId: slot.factoryId,
        slotId: slot.slotId,
        launchId: slot.launchId,
        conversationRef,
        situation: "compaction",
        parts: composed.prime.parts,
      }),
    );

    try {
      await writer.sendFirst({ type: "prime", id: primeId, text: composed.prime.text });
    } catch (error) {
      return CompactionPrimingOutcome.SendFailed({ primeId, error });
    }

    // Enqueue only after the prime is written, while ordinary work is still held.
    if (options.clonePath !== undefined) {
      await run(resendAssignmentRepositoryContext(options.store, {
        factoryId: slot.factoryId, slotId: slot.slotId,
        clonePath: options.clonePath(slot.factoryId), isolation: request.isolation,
      }));
    }

    return CompactionPrimingOutcome.Sent({ primeId });
  };

  return {
    prime(slot, hello, connection) {
      // A frozen slot's prime waits for its unfreeze and is decided afresh then; a connection
      // that ends first gets none, so it never holds up a later hello for the slot.
      const outcome = serialized(slot, async () =>
        (await whenSendable(gate, slot, connection.closed)) ? decideAndSend(slot, hello, connection) : PrimingOutcome.Closed(),
      );

      const writer = new PrimedWriter(connection, outcome, gate, slot);
      live.set(slotKey(slot), { launchId: slot.launchId, conversationRef: hello.conversationRef, writer, closed: connection.closed });

      const guarded: AcceptedConnection = { send: (frame: DaemonFrame) => writer.send(frame) };

      return { outcome, connection: connection.closed === undefined ? guarded : { ...guarded, closed: connection.closed } };
    },
    receipt: (slot, id) =>
      run(acknowledgePrime(options.store, { factoryId: slot.factoryId, slotId: slot.slotId, id })),
    compacted(slot) {
      const current = live.get(slotKey(slot));

      if (current === undefined || current.launchId !== slot.launchId) {return Promise.resolve(CompactionPrimingOutcome.NotConnected());}

      // Held now, not once composition starts, so no work frame slips out ahead of the prime.
      const release = current.writer.hold();

      const outcome = serialized(slot, async () =>
        (await whenSendable(gate, slot, current.closed))
          ? sendCompactionPrime(slot, current.conversationRef, current.writer, current.closed)
          : CompactionPrimingOutcome.NotConnected(),
      );

      void outcome.then(release, release);

      return outcome;
    },
  };
};
