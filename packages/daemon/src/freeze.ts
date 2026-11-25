/**
 * Freezing and unfreezing slots under a frozen-slot operator hold (PRD §5.3, §10.2).
 *
 * A frozen slot keeps its assignment and bound work in place; the daemon sends it nothing and
 * launches nothing into it until the operator unfreezes (or resets) it. Other slots carry on.
 * Freezing writes the slot's condition, its cause and its hold in one transaction (ADR 0001).
 *
 * Unfreeze is the operator asserting the cause is fixed. The daemon re-runs the cause's check and
 * stays frozen, refreshing the hold's evidence, while the cause persists. A cause with no check
 * registered is never unfrozen on trust.
 *
 * The causes themselves (host lost, unknown ownership, a changed conversation, a prime without
 * history, a missing instruction file, a Tool Set mismatch) are raised by their own tickets,
 * which also register their checks. The agent tool-call transport (FOU-36) refuses calls from a
 * still-connected worker whose slot `isFrozen` (PRD §5.3).
 */
import { Data, Effect } from "effect";
import type { HoldEvidence } from "@foundry/protocol/holds";
import type { FreezeCause } from "@foundry/protocol/slots-api";
import { slotRecord } from "./history-records.js";
import { closeOpenHoldIn, raiseHoldIn } from "./holds.js";
import { SlotsError } from "./slots-error.js";
import type { SlotControl, SlotsReader } from "./slots-error.js";
import type { Change, Store, StoreError } from "./store.js";

/** A slot of a factory. */
export interface SlotRef {
  readonly factoryId: string;
  /** `station/ordinal`. */
  readonly slotId: string;
}

/** What re-running a freeze cause's check found: fixed, or still failing with fresh evidence. */
export type CauseCheckResult =
  | { readonly fixed: true }
  | { readonly fixed: false; readonly evidence: HoldEvidence };

/** Re-runs the check that froze a slot. */
export type CauseCheck = (slot: SlotRef) => Promise<CauseCheckResult>;

/** The check per freeze cause; a cause without one is never unfrozen. */
export type FreezeChecks = Partial<Record<FreezeCause, CauseCheck>>;

/** What the frozen-slot hold shows (PRD §10.2): the cause plus its kind-specific evidence. */
export interface FreezeRequest extends SlotRef {
  readonly cause: FreezeCause;
  readonly evidence: HoldEvidence;
  /**
   * The configured slot's station address and ordinal, to create its record in the freeze's own
   * transaction when it has none yet (a slot first seen holding an unproven launch).
   */
  readonly create?: { readonly station: string; readonly ordinal: number };
}

/**
 * - `frozen`: the slot is now frozen with this cause, and its hold open or refreshed.
 * - `unknown_slot`: no slot record exists; nothing was written.
 * - `parked`: parking takes precedence; nothing was written. Only reset may unpark.
 */
export type FreezeOutcome = "frozen" | "unknown_slot" | "parked";

export type UnfreezeResult =
  | { readonly outcome: "unfrozen"; readonly resolvedHold: number | null }
  | { readonly outcome: "not_frozen" }
  | { readonly outcome: "cause_persists"; readonly cause: FreezeCause; readonly holdId: number; readonly evidence: HoldEvidence }
  | { readonly outcome: "no_check"; readonly cause: FreezeCause };

/** Which slots are frozen, read synchronously by whatever would send to or act for a slot. */
export interface SlotGate {
  isFrozen(slot: SlotRef): boolean;
  /** Calls `listener` after a slot is unfrozen; returns a function that removes it. */
  onUnfrozen(listener: (slot: SlotRef) => void): () => void;
}

export interface SlotFreezer extends SlotGate {
  freeze(request: FreezeRequest): Promise<FreezeOutcome>;
  /** Re-runs the slot's cause check and unfreezes it only if the check passes. */
  unfreeze(slot: SlotRef): Promise<UnfreezeResult>;
  /** Gates senders and serializes with freeze/unfreeze while the scheduler replaces a conversation. */
  reset<A>(slot: SlotRef, work: () => Promise<A>): Promise<A>;
}

export interface SlotFreezerOptions {
  readonly store: Store;
  readonly checks: FreezeChecks;
}

interface FrozenRow {
  readonly factory_id: string;
  readonly slot_id: string;
  readonly condition: string;
  readonly freeze_cause: FreezeCause | null;
}

class StaleUnfreeze extends Data.TaggedError("StaleUnfreeze") {}

class ParkedFreeze extends Data.TaggedError("ParkedFreeze") {}

/** An asynchronous check cannot resolve a slot which has since parked or changed cause. */
const requireSameFreeze = (change: Change, slot: SlotRef, cause: FreezeCause) => Effect.gen(function* () {
  const rows = yield* change.query(
    `SELECT 1 FROM slot WHERE factory_id = ? AND slot_id = ? AND condition = 'frozen' AND freeze_cause = ?`,
    [slot.factoryId, slot.slotId, cause],
  );

  if (rows.length === 0) {return yield* new StaleUnfreeze();}
});

const keyOf = (slot: SlotRef): string => JSON.stringify([slot.factoryId, slot.slotId]);

const holdOf = (slot: SlotRef) => ({ factoryId: slot.factoryId, kind: "frozen_slot", subject: slot.slotId }) as const;

const run = <A>(effect: Effect.Effect<A, StoreError>): Promise<A> => Effect.runPromise(effect);

/**
 * Resolves `true` once `slot` is not frozen (at once if it is not frozen now), or `false` if
 * `until` settles first, such as the connection waiting on it closing. Either way its unfreeze
 * listener is removed.
 */
export const whenSendable = (gate: SlotGate, slot: SlotRef, until?: Promise<unknown>): Promise<boolean> =>
  new Promise((resolve) => {
    if (!gate.isFrozen(slot)) {
      resolve(true);

      return;
    }

    const off = gate.onUnfrozen((unfrozen) => {
      if (keyOf(unfrozen) !== keyOf(slot) || gate.isFrozen(slot)) {return;}

      off();
      resolve(true);
    });

    const give = () => {
      off();
      resolve(false);
    };

    void until?.then(give, give);
  });

/** A gate that never holds anything back, for callers without freezing. */
export const openSlotGate: SlotGate = { isFrozen: () => false, onUnfrozen: () => () => {} };

/** Loads the slots already frozen, then freezes and unfreezes one operation at a time. */
export const createSlotFreezer = async (options: SlotFreezerOptions): Promise<SlotFreezer> => {
  const { store, checks } = options;

  const frozen = new Set(
    (await run(store.read<FrozenRow>(`SELECT factory_id, slot_id FROM slot WHERE condition IN ('frozen', 'parked')`))).map((row) =>
      keyOf({ factoryId: row.factory_id, slotId: row.slot_id }),
    ),
  );

  const listeners = new Set<(slot: SlotRef) => void>();
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const next = tail.then(work);
    tail = next.catch(() => {});

    return next;
  };

  const readSlot = (slot: SlotRef) =>
    Effect.map(
      store.read<FrozenRow>(`SELECT factory_id, slot_id, condition, freeze_cause FROM slot WHERE factory_id = ? AND slot_id = ?`, [
        slot.factoryId,
        slot.slotId,
      ]),
      (rows) => rows[0],
    );

  const freeze = async (request: FreezeRequest): Promise<FreezeOutcome> => {
    const slot: SlotRef = { factoryId: request.factoryId, slotId: request.slotId };

    if (request.create === undefined && (await run(readSlot(slot))) === undefined) {return "unknown_slot";}

    // Gated before the commit, so no frame slips out while the freeze is being written.
    const key = keyOf(slot);
    const wasFrozen = frozen.has(key);
    frozen.add(key);

    try {
      return await run(
        store.change((change) =>
          Effect.gen(function* () {
            if (request.create !== undefined) {
              yield* change.query(
                `INSERT INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, ?, ?, ?, 'normal')
                 ON CONFLICT (factory_id, slot_id) DO NOTHING`,
                [slot.factoryId, slot.slotId, request.create.station, request.create.ordinal],
              );
            }

            // Recovery may have parked while this freeze waited in the queue. Never downgrade it.
            const parked = yield* change.query(
              `SELECT 1 FROM slot WHERE factory_id = ? AND slot_id = ? AND condition = 'parked'`,
              [slot.factoryId, slot.slotId],
            );

            if (parked.length !== 0) {return yield* new ParkedFreeze();}

            yield* change.query(`UPDATE slot SET condition = 'frozen', freeze_cause = ? WHERE factory_id = ? AND slot_id = ?`, [
              request.cause,
              slot.factoryId,
              slot.slotId,
            ]);
            const { hold } = yield* raiseHoldIn(change, { ...holdOf(slot), evidence: { cause: request.cause, ...request.evidence } });
            yield* change.recordHistory({
              factoryId: slot.factoryId,
              kind: "slot.frozen",
              subject: slot.slotId,
              detail: { cause: request.cause, holdId: hold.id },
              records: [slotRecord(slot.slotId)],
            });

            return "frozen" as const;
          }),
        ).pipe(Effect.catchTag("ParkedFreeze", () => Effect.succeed("parked" as const))),
      );
    } catch (cause) {
      if (!wasFrozen) {frozen.delete(key);}

      throw cause;
    }
  };

  const unfreeze = async (slot: SlotRef): Promise<UnfreezeResult> => {
    const row = await run(readSlot(slot));

    if (row?.condition !== "frozen" || row.freeze_cause === null) {return { outcome: "not_frozen" };}

    const cause = row.freeze_cause;
    const check = checks[cause];

    if (check === undefined) {return { outcome: "no_check", cause };}

    const checked = await check(slot);

    if (!checked.fixed) {
      const evidence = { cause, ...checked.evidence };

      const holdId = await run(
        store.change((change) =>
          Effect.gen(function* () {
            yield* requireSameFreeze(change, slot, cause);
            const { hold } = yield* raiseHoldIn(change, { ...holdOf(slot), evidence });
            yield* change.recordHistory({
              factoryId: slot.factoryId,
              // PRD §5.3: an unfreeze whose check still fails freezes the slot again.
              kind: "slot.frozen",
              subject: slot.slotId,
              detail: { cause, holdId: hold.id, refrozen: true },
              records: [slotRecord(slot.slotId)],
            });

            return hold.id;
          }),
        ).pipe(Effect.catchTag("StaleUnfreeze", () => Effect.succeed(undefined))),
      );

      if (holdId === undefined) {return { outcome: "not_frozen" };}

      return { outcome: "cause_persists", cause, holdId, evidence };
    }

    const resolved = await run(
      store.change((change) =>
        Effect.gen(function* () {
          yield* requireSameFreeze(change, slot, cause);
          yield* change.query(`UPDATE slot SET condition = 'normal', freeze_cause = NULL WHERE factory_id = ? AND slot_id = ?`, [
            slot.factoryId,
            slot.slotId,
          ]);
          const hold = yield* closeOpenHoldIn(change, holdOf(slot), "resolved");
          yield* change.recordHistory({
            factoryId: slot.factoryId,
            kind: "slot.unfrozen",
            subject: slot.slotId,
            detail: { cause, holdId: hold?.id ?? null },
            records: [slotRecord(slot.slotId)],
          });

          return hold?.id ?? null;
        }),
      ).pipe(Effect.catchTag("StaleUnfreeze", () => Effect.succeed(undefined))),
    );

    if (resolved === undefined) {return { outcome: "not_frozen" };}

    frozen.delete(keyOf(slot));

    for (const listener of Array.from(listeners)) {
      try {
        listener(slot);
      } catch {
        // A listener only signals senders; the unfreeze has committed.
      }
    }

    return { outcome: "unfrozen", resolvedHold: resolved };
  };

  return {
    isFrozen: (slot) => frozen.has(keyOf(slot)),
    onUnfrozen: (listener) => {
      const registered = (slot: SlotRef) => listener(slot);
      listeners.add(registered);

      return () => void listeners.delete(registered);
    },
    freeze: (request) => serial(() => freeze(request)),
    unfreeze: (slot) => serial(() => unfreeze(slot)),
    reset: (slot, work) => serial(async () => {
      const key = keyOf(slot);
      frozen.add(key);

      try {
        return await work();
      } finally {
        // On failure keep a persisted freeze gated; on success release the new conversation.
        const row = await run(readSlot(slot));

        if (row?.condition !== "frozen" && row?.condition !== "parked") {
          frozen.delete(key);

          for (const listener of Array.from(listeners)) {
            try { listener(slot); } catch { /* State has already committed. */ }
          }
        }
      }
    }),
  };
};

/** `foundry slot unfreeze` over the management API: addresses the slot as the reader does. */
export const storeSlotControl = (reader: SlotsReader, freezer: Pick<SlotFreezer, "unfreeze">): SlotControl => ({
  unfreeze: async (slotId, factory) => {
    // Resolves the factory and refuses an unknown slot exactly as `slot show` does.
    const { slot } = await reader.show(slotId, factory);
    const result = await freezer.unfreeze({ factoryId: slot.factoryId, slotId });

    switch (result.outcome) {
      case "not_frozen":
        throw new SlotsError("not_frozen", `Slot ${slotId} is not frozen`);
      case "no_check":
        throw new SlotsError("no_cause_check", `Slot ${slotId} is frozen for ${result.cause}, which has no check to re-run; reset it instead`);
      case "cause_persists":
        throw new SlotsError(
          "cause_persists",
          `Slot ${slotId} stays frozen: ${result.cause} still fails its check (hold ${result.holdId}, evidence refreshed)`,
        );
      case "unfrozen":
        return { slot: (await reader.show(slotId, slot.factoryId)).slot, resolvedHold: result.resolvedHold };
    }
  },
});
