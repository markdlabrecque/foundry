/**
 * Fixed slots and their launches (PRD §3.2, §5.2–5.3, §10.1, §11.2).
 *
 * Each started factory's configured capacity becomes slots: a persistent station has one, a
 * pooled station `instances` of them, written `station/ordinal`. Scheduling asks the Worker Host
 * which launch holds each slot (`ownership.ts`, PRD §10.2 step 2) and launches only into a slot the
 * host confirms vacant, so repeated or concurrent scheduling never starts a second launch in a
 * slot. A proven launch is kept, never replaced: the slot's recorded current launch, or one this
 * same host started for a request whose reply the daemon lost. Unproven ownership (an unrecorded
 * live launch, several live launches, or a recorded launch or request a new host on the same boot
 * does not know) freezes the slot rather than adopting an orphan.
 *
 * The `slot` and `launch` tables are current state; every change writes its `launch.*` history
 * row in the same transaction (ADR 0001). Where host and database disagree, the host wins on
 * liveness and the database on everything else.
 *
 * A frozen slot (`freeze.ts`) is never launched into: scheduling reports it `held`.
 *
 * Each slot has one current conversation, issued by the daemon at its first launch request and
 * opened by every launch of the slot (PRD §10.1). A launch the host positively reports as having
 * exited unasked, by a signal or with a non-zero code (the host's own `exitWasUnexpected` rule),
 * ended unexpectedly: the slot is relaunched in the same conversation, and its `launch.ended` row
 * is marked `unexpected` for recovery accounting (PRD §5.3, §10.2). A clean, unasked exit (code 0)
 * is recorded but neither counted nor relaunched. A lost channel is not death evidence and never
 * causes a relaunch.
 *
 * A host started after a reboot is positive proof that every launch of an earlier boot is gone
 * (PRD §10.2): such a slot is vacant and gets an ordinary recovery launch in its conversation, and
 * the end is counted like an unexpected one. A launch kept because it is proven still running
 * records no end and counts nothing. A recorded launch unknown to a new host on the same boot is
 * not proof of anything: that slot freezes (`ownership.ts`).
 *
 * Unexpected ends count atomically with their record; at the ceiling the slot parks and any
 * assignment suspends with its ticket paused. The recovery prime and resume notice are separate.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Clock, Data, Effect, Schema } from "effect";
import { buildLaunchArgs, connectHost, exitWasUnexpected, HostRefusedError, launchStderrPath, startHost } from "@foundry/host";
import type { HostConnection, LaunchRecord, LaunchSpec, PiExecutable, Termination } from "@foundry/host";
import { CHANNEL_SOCKET_ENV, channelSocketPath } from "@foundry/protocol";
import { codeOf, messageOf } from "@foundry/protocol/errors";
import { FreezeCause, SLOT_INTERRUPT_ACK_TIMEOUT_MS, SlotCondition, slotIdOf } from "@foundry/protocol/slots-api";
import type { LaunchEndReason, SlotLaunch, SlotLaunchHistoryEntry, SlotSummary } from "@foundry/protocol/slots-api";
import { SlotsError } from "./slots-error.js";
import { canonicalSource, expectedToolSet } from "./tool-set-check.js";
import type { HoldEvidence } from "@foundry/protocol/holds";
import type { SlotInterrupter, SlotsReader } from "./slots-error.js";
import { ChannelUnavailableError } from "./channel/server.js";
import type { ChannelServer } from "./channel/server.js";
import type { EffectiveStation } from "./config/index.js";
import { slotRecord } from "./history-records.js";
import { closeOpenHoldIn } from "./holds.js";
import { classifyOwnership } from "./ownership.js";
import { countUnexpectedEndIn } from "./recovery.js";
import type { RecordedSlot, SlotOwnership } from "./ownership.js";
import type { CauseCheck, CauseCheckResult, FreezeRequest, SlotFreezer, SlotRef } from "./freeze.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Change, Store, StoreError } from "./store.js";

/** Directory, relative to the state root, holding each slot's neutral launch folder (PRD §3.2). */
export const SLOTS_DIR_NAME = "slots";

/** One configured slot of a started factory. */
export interface PlannedSlot {
  readonly factoryId: string;
  /** `station/ordinal`. */
  readonly slotId: string;
  readonly ordinal: number;
  readonly station: EffectiveStation;
}

/** A factory's slots from its effective stations, in configuration order (PRD §5.2). */
export const planSlots = (factoryId: string, stations: ReadonlyArray<EffectiveStation>): ReadonlyArray<PlannedSlot> =>
  stations.flatMap((station) =>
    Array.from({ length: station.instances }, (_, index) => ({
      factoryId,
      slotId: slotIdOf(station.station, index + 1),
      ordinal: index + 1,
      station,
    })),
  );

/** The neutral per-slot folder a slot's launches run in, never a worktree or the clone. */
export const slotDirectory = (stateRoot: string, factoryId: string, slotId: string): string =>
  join(stateRoot, SLOTS_DIR_NAME, factoryId, slotId.replace("/", "-"));

/** What the scheduler needs from the Worker Host; a `HostConnection` satisfies it. */
export interface SlotHost {
  inventory(): Promise<ReadonlyArray<LaunchRecord>>;
  launch(spec: LaunchSpec): Promise<LaunchRecord>;
}

interface SlotRow {
  readonly factory_id: string;
  readonly slot_id: string;
  readonly station: string;
  readonly ordinal: number;
  readonly condition: string;
  readonly current_launch: string | null;
  readonly pending_host: string | null;
  readonly pending_boot: string | null;
  readonly freeze_cause: string | null;
}

interface LaunchRow {
  readonly launch_id: string;
  readonly factory_id: string;
  readonly slot_id: string;
  readonly boot_id: string;
  readonly pid: number;
  readonly started_at: number;
  /** `adopted` appears only on rows written before FOU-80; unproven launches are no longer adopted. */
  readonly origin: "started" | "adopted";
  readonly ended_at: number | null;
  readonly end_reason: LaunchEndReason | null;
  readonly exit_code: number | null;
  readonly exit_signal: string | null;
}

const SLOT_COLUMNS = `factory_id, slot_id, station, ordinal, condition, current_launch, pending_host, pending_boot, freeze_cause`;
const LAUNCH_COLUMNS = `launch_id, factory_id, slot_id, boot_id, pid, started_at, origin, ended_at, end_reason, exit_code, exit_signal`;

const readSlot = (store: Store, factoryId: string, slotId: string) =>
  Effect.map(
    store.read<SlotRow>(`SELECT ${SLOT_COLUMNS} FROM slot WHERE factory_id = ? AND slot_id = ?`, [factoryId, slotId]),
    (rows) => rows[0],
  );

const readLaunch = (store: Store, launchId: string) =>
  Effect.map(store.read<LaunchRow>(`SELECT ${LAUNCH_COLUMNS} FROM launch WHERE launch_id = ?`, [launchId]), (rows) => rows[0]);

/** The slot's current conversation reference, if it has one. */
const readConversation = (store: Store, factoryId: string, slotId: string) =>
  Effect.map(
    store.read<{ readonly ref: string }>(
      `SELECT ref FROM conversation WHERE factory_id = ? AND slot_id = ? AND status = 'current'`,
      [factoryId, slotId],
    ),
    (rows) => rows[0]?.ref,
  );

const insertSlot = (change: Change, slot: PlannedSlot) =>
  change.query(
    `INSERT OR IGNORE INTO slot (factory_id, slot_id, station, ordinal, condition) VALUES (?, ?, ?, ?, 'normal')`,
    [slot.factoryId, slot.slotId, slot.station.address, slot.ordinal],
  );

/** The host process and machine boot a launch is asked of. */
interface HostRef {
  readonly hostId: string;
  readonly bootId: string;
}

/**
 * Records that the daemon is about to ask the host for a launch, creating the slot record if new.
 * The slot keeps the request pending until the launch is recorded, so a daemon that dies between
 * the host's spawn and its record can tell, after restarting, whether a launch may already exist.
 * The slot's conversation becomes current with the first request; later requests keep it.
 * Its history row's subject is the slot: no launch ID exists yet.
 */
const recordRequested = (
  store: Store,
  slot: PlannedSlot,
  host: HostRef,
  conversationRef: string,
): Effect.Effect<void, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* change.query(
        `INSERT INTO slot (factory_id, slot_id, station, ordinal, condition, pending_host, pending_boot)
         VALUES (?, ?, ?, ?, 'normal', ?, ?)
         ON CONFLICT (factory_id, slot_id) DO UPDATE SET pending_host = excluded.pending_host, pending_boot = excluded.pending_boot`,
        [slot.factoryId, slot.slotId, slot.station.address, slot.ordinal, host.hostId, host.bootId],
      );
      // A no-op when the slot already has a current conversation (`conversation_one_current`);
      // the caller read that conversation and passes its ref, so the history row matches it.
      yield* change.query(
        `INSERT INTO conversation (factory_id, slot_id, ref, status, created_at) VALUES (?, ?, ?, 'current', ?)
         ON CONFLICT (factory_id, slot_id) WHERE status = 'current' DO NOTHING`,
        [slot.factoryId, slot.slotId, conversationRef, now],
      );
      yield* change.recordHistory({
        factoryId: slot.factoryId,
        kind: "launch.requested",
        subject: slot.slotId,
        detail: { station: slot.station.address, hostId: host.hostId, conversationRef },
        records: [slotRecord(slot.slotId)],
      });
    }),
  );

/**
 * Records that the host refused a requested launch, which proves it never started: the request is
 * no longer pending, so a later host in this boot may launch into the slot.
 */
const recordRefused = (store: Store, slot: PlannedSlot, reason: string): Effect.Effect<void, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      yield* change.query(`UPDATE slot SET pending_host = NULL, pending_boot = NULL WHERE factory_id = ? AND slot_id = ?`, [
        slot.factoryId,
        slot.slotId,
      ]);
      yield* change.recordHistory({
        factoryId: slot.factoryId,
        kind: "launch.refused",
        subject: slot.slotId,
        detail: { station: slot.station.address, reason },
        records: [slotRecord(slot.slotId)],
      });
    }),
  );

/**
 * Records a launch the host reports as the slot's current launch: one it `started` for us, or one
 * `adopted`. A launch already recorded is not inserted again; it only becomes current. Clears any
 * pending request.
 */
const recordLaunch = (store: Store, slot: PlannedSlot, launch: LaunchRecord): Effect.Effect<void, StoreError> =>
  store.change((change) =>
    Effect.gen(function* () {
      yield* insertSlot(change, slot);
      yield* change.query(
        `INSERT INTO launch (launch_id, factory_id, slot_id, boot_id, pid, started_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (launch_id) DO NOTHING`,
        [launch.launchId, launch.factoryId, launch.slotId, launch.bootId, launch.pid, Date.parse(launch.startedAt), "started"],
      );
      yield* change.query(`UPDATE slot SET current_launch = ?, pending_host = NULL, pending_boot = NULL WHERE factory_id = ? AND slot_id = ?`, [
        launch.launchId,
        slot.factoryId,
        slot.slotId,
      ]);
      yield* change.recordHistory({
        factoryId: slot.factoryId,
        kind: "launch.started",
        subject: launch.launchId,
        detail: { slotId: slot.slotId, pid: launch.pid, bootId: launch.bootId },
        records: [slotRecord(slot.slotId)],
      });
    }),
  );

/** The host answering now and its whole inventory. */
interface HostView {
  readonly hostId: string;
  readonly bootId: string;
  readonly inventory: ReadonlyArray<LaunchRecord>;
}

/** Reads the slot's records and asks `classifyOwnership` who holds it. */
const classifySlot = (store: Store, slot: SlotRef, host: HostView): Effect.Effect<SlotOwnership, StoreError> =>
  Effect.gen(function* () {
    const row = yield* readSlot(store, slot.factoryId, slot.slotId);

    const launchIds = yield* store.read<{ launch_id: string }>(`SELECT launch_id FROM launch WHERE factory_id = ? AND slot_id = ?`, [
      slot.factoryId,
      slot.slotId,
    ]);

    const currentId = row?.current_launch ?? null;
    const current = currentId === null ? undefined : yield* readLaunch(store, currentId);

    const recorded: RecordedSlot = {
      current:
        currentId === null
          ? null
          : { launchId: currentId, bootId: current?.boot_id ?? null, ended: current === undefined || current.ended_at !== null },
      pending:
        row?.pending_host === null || row?.pending_host === undefined || row.pending_boot === null
          ? null
          : { hostId: row.pending_host, bootId: row.pending_boot },
      recorded: new Set(launchIds.map((l) => l.launch_id)),
    };

    return classifyOwnership(recorded, {
      hostId: host.hostId,
      bootId: host.bootId,
      launches: host.inventory.filter((launch) => launch.factoryId === slot.factoryId && launch.slotId === slot.slotId),
    });
  });

/**
 * Records what a classification proves, so the store agrees with the host (ADR 0001): a launch from
 * an earlier boot ended by the machine restart, or a launch this same host started for a pending
 * request, with its end if it is already gone. Other classifications need no write.
 */
const applyOwnership = async (store: Store, slot: PlannedSlot, ownership: SlotOwnership, limit: number, configLoad: string | null): Promise<void> => {
  if (ownership.kind === "rebooted") {
    const endedAt = await Effect.runPromise(Clock.currentTimeMillis);
    await Effect.runPromise(recordEnd(store, ownership.launchId, { reason: "machine_restarted", endedAt, code: null, signal: null }, limit, configLoad));

    return;
  }

  if (ownership.kind !== "claimed") {return;}

  await Effect.runPromise(recordLaunch(store, slot, ownership.launch));
  const end = endOf(ownership.launch);

  if (end !== undefined) {await Effect.runPromise(recordEnd(store, ownership.launch.launchId, end, limit, configLoad));}
};

interface LaunchEnd {
  readonly reason: LaunchEndReason;
  /** Wall-clock ms. */
  readonly endedAt: number;
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * Records the end of a recorded launch once; a launch already ended or never recorded is left alone.
 * An unasked exit by a signal or a non-zero code, and a machine restart, are marked `unexpected`:
 * the event recovery accounting counts (PRD §5.3, §10.2). A clean exit or a requested stop is not.
 */
class NoNewEnd extends Data.TaggedError("NoNewEnd") {}

const recordEnd = (store: Store, launchId: string, end: LaunchEnd, limit: number, configLoad: string | null): Effect.Effect<boolean, StoreError> =>
  store.change((change) =>
      Effect.gen(function* () {
        const rows = yield* change.query<LaunchRow>(
          `UPDATE launch SET ended_at = ?, end_reason = ?, exit_code = ?, exit_signal = ?
           WHERE launch_id = ? AND ended_at IS NULL RETURNING ${LAUNCH_COLUMNS}`,
          [end.endedAt, end.reason, end.code, end.signal, launchId],
        );

        const known = rows[0];

        if (known === undefined) {return yield* new NoNewEnd();}

        if (unexpectedEnd(end.reason, end.code, end.signal)) {
          yield* countUnexpectedEndIn(change, known.factory_id, known.slot_id, launchId, limit, configLoad);
        }

        yield* change.recordHistory({
          factoryId: known.factory_id,
          kind: "launch.ended",
          subject: launchId,
          detail: {
            slotId: known.slot_id,
            reason: end.reason,
            unexpected: unexpectedEnd(end.reason, end.code, end.signal),
            code: end.code,
            signal: end.signal,
          },
          records: [slotRecord(known.slot_id)],
        });

        return true;
      }),
    ).pipe(Effect.catchTag("NoNewEnd", () => Effect.succeed(false)));

/**
 * Whether a recorded end counts against the recovery limit: the host's rule for exits it saw
 * unasked, and every launch a machine restart ended (PRD §10.2).
 */
const refuseRestart = (message: string): never => { throw new SlotsError("restart_refused", message); };

const unexpectedEnd = (reason: LaunchEndReason | null, code: number | null, signal: string | null): boolean =>
  reason === "machine_restarted" || (reason === "exited" && exitWasUnexpected({ code, signal }));

const endOf = (launch: LaunchRecord): LaunchEnd | undefined =>
  launch.exit === undefined
    ? undefined
    : {
        reason: launch.exit.requested === true ? "requested" : "exited",
        endedAt: Date.parse(launch.exit.endedAt),
        code: launch.exit.code,
        signal: launch.exit.signal,
      };

/**
 * What scheduling did with one slot.
 *
 * - `started`: the host started its first launch.
 * - `relaunched`: its launch ended unexpectedly (a signal or non-zero code, unasked) or with a
 *   machine restart; the host started a new one in the same conversation.
 * - `running`: its recorded launch is still live, whether or not its worker's channel is connected.
 * - `ended`: its launch exited cleanly or was stopped on request; it is not relaunched here.
 * - `frozen`: ownership is unproven (`ownership.ts`); the slot is now frozen and nothing is adopted or started.
 * - `held`: its condition is not normal; nothing is launched into it.
 * - `stopped`: its factory is stopping or stopped (PRD §10.3); the slot is not touched.
 * - `refused`: the launch could not be built or the host would not start it; the next daemon start tries again.
 */
export type SlotScheduleOutcome =
  | "started"
  | "relaunched"
  | "running"
  | "ended"
  | "frozen"
  | "held"
  | "stopped"
  | "refused";

export interface SlotScheduleResult {
  readonly factoryId: string;
  readonly slotId: string;
  readonly outcome: SlotScheduleOutcome;
  readonly launchId?: string;
  /** Why the launch was refused, for `refused`. */
  readonly error?: string;
}

export interface SlotSchedulerOptions {
  readonly store: Store;
  readonly stateRoot: string;
  readonly host: SlotHost;
  /** The host process answering now; its inventory is complete for every launch it started. */
  readonly hostId: string;
  /** The machine boot the host runs in; a recorded launch from another boot is known gone (PRD §10.2). */
  readonly bootId: string;
  /** The pinned Pi, or the test's stub (`FOUNDRY_PI_BIN`). */
  readonly pi: PiExecutable;
  /** Absolute path of the Foundry Pi extension entry point. */
  readonly foundryExtension: string;
  /** The configured slots of the started factories. */
  readonly slots: ReadonlyArray<PlannedSlot>;
  /** Freezes a slot whose ownership is unproven (PRD §10.2), under a frozen-slot hold. */
  readonly freezer: Pick<SlotFreezer, "freeze"> & Partial<Pick<SlotFreezer, "reset">>;
  /** Reset requires positive process-group evidence, not just a reaped leader. */
  readonly terminate?: (launchId: string) => Promise<Termination>;
  readonly revokeSlot?: (factoryId: string, slotId: string) => void;
  /**
   * Whether a factory may still be assigned new launches; checked per slot, so a factory stop
   * begun mid-schedule launches nothing more in its scope. Default: every factory.
   */
  readonly inScope?: (factoryId: string) => boolean;
  /** Factory configuration for idle-slot accounting; assignment ceilings are already stored. */
  readonly recoveryLimit?: (factoryId: string) => number;
  readonly configLoad?: (factoryId: string) => string | undefined;
  /** Resolves a pending unfreeze recheck; true means it owns writing the hold. */
  readonly startupMismatch?: (slot: SlotRef, launchId: string, evidence: HoldEvidence) => boolean;
}

/** What handling a host-reported launch exit did. */
export interface LaunchExitResult {
  /** True when it ended a recorded launch. */
  readonly ended: boolean;
  /** How the slot was rescheduled after an unexpected end, if it was. */
  readonly recovery?: SlotScheduleResult;
}

export interface SlotScheduler {
  /**
   * Reconciles every slot with the host, launches into each vacant, never-launched one, and
   * relaunches each whose launch ended unexpectedly or with a machine restart.
   */
  schedule(): Promise<ReadonlyArray<SlotScheduleResult>>;
  /** Reconciles ownership and recovers a proven vacancy before clearing the frozen-slot hold. */
  readonly recheckOwnership: CauseCheck;
  /** Records a launch exit the host reported, without relaunching; true when it ended a recorded launch. */
  recordExit(launch: LaunchRecord): Promise<boolean>;
  /**
   * Records a launch exit the host reported and, when the launch ended unexpectedly, reschedules its
   * slot through the same checks as `schedule`, which relaunch it in the same conversation only if
   * the ended launch is still the slot's current one. A host that cannot be asked is reported as a
   * `refused` recovery; the end stays recorded.
   */
  launchExited(launch: LaunchRecord): Promise<LaunchExitResult>;
  /**
   * Starts a new launch in a slot whose launch is gone, in its current conversation, which must be
   * `conversationRef` (PRD §5.3, unfreezing a Tool Set mismatch). Ignores the slot's condition: the
   * caller is the unfreeze. Rejects while the host reports a live launch in the slot, when the
   * slot's conversation has changed, or if the launch is refused.
   */
  relaunch(slot: { readonly factoryId: string; readonly slotId: string }, conversationRef: string): Promise<{ readonly launchId: string }>;
  /** Operator restart: terminate the owned group, then continue the current conversation. */
  restart(slot: SlotRef): Promise<{ readonly launchId: string }>;
  /** Discards a held slot's conversation only after proving old groups gone, unless forced. */
  reset(slot: SlotRef, force?: boolean): Promise<{ readonly launchId: string }>;
  /** Resolves once scheduling and exit reports queued so far have finished. */
  idle(): Promise<void>;
}

/** Scheduling and exit reports run one at a time, so a slot is never launched into twice. */
export const createSlotScheduler = (options: SlotSchedulerOptions): SlotScheduler => {
  const { store, host } = options;
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const run = tail.then(work);
    tail = run.catch(() => {});

    return run;
  };

  // A cause check may hold the freezer queue while calling the scheduler. Persist scheduling
  // freezes only after releasing the scheduler queue, and don't schedule their slots in between.
  const pendingFreezes = new Set<PlannedSlot>();

  const scheduleWithFreezes = async <A>(work: (defer: (request: FreezeRequest, slot: PlannedSlot) => void) => Promise<A>): Promise<A> => {
    const freezes: Array<{ request: FreezeRequest; slot: PlannedSlot }> = [];

    try {
      return await serial(() => work((request, slot) => {
        pendingFreezes.add(slot);
        freezes.push({ request, slot });
      }));
    } finally {
      await Promise.all(freezes.map(async ({ request, slot }) => {
        try {
          await options.freezer.freeze(request);
        } finally {
          pendingFreezes.delete(slot);
        }
      }));
    }
  };

  const scheduleSlot = async (
    slot: PlannedSlot,
    inventory: ReadonlyArray<LaunchRecord>,
    onUnproven: (request: FreezeRequest, slot: PlannedSlot) => void,
    rechecking = false,
  ): Promise<SlotScheduleResult> => {
    const result = (outcome: SlotScheduleOutcome, launchId?: string): SlotScheduleResult =>
      launchId === undefined
        ? { factoryId: slot.factoryId, slotId: slot.slotId, outcome }
        : { factoryId: slot.factoryId, slotId: slot.slotId, outcome, launchId };

    if (options.inScope !== undefined && !options.inScope(slot.factoryId)) {return result("stopped");}

    const row = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));

    if (pendingFreezes.has(slot) || (rechecking ? row?.condition !== "frozen" : row !== undefined && row.condition !== "normal")) {
      return result("held");
    }

    const ownership = await Effect.runPromise(
      classifySlot(store, slot, { hostId: options.hostId, bootId: options.bootId, inventory }),
    );

    /** A recorded unexpected exit or reboot lets the slot continue its conversation. */
    const relaunchIfUnexpected = async (launchId: string): Promise<SlotScheduleResult> => {
      const condition = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));

      if (condition?.condition === "parked") {return result("held", launchId);}

      const recorded = await Effect.runPromise(readLaunch(store, launchId));

      return recorded !== undefined && unexpectedEnd(recorded.end_reason, recorded.exit_code, recorded.exit_signal)
        ? launchInto(slot, "relaunched")
        : result("ended", launchId);
    };

    switch (ownership.kind) {
      case "running":
        return result("running", ownership.launchId);
      case "ended":
        return relaunchIfUnexpected(ownership.launchId);
      case "rebooted":
        // Not live on the host, from an earlier boot: the machine restart proves it gone, so the
        // slot is vacant and gets an ordinary recovery launch, counted by its recorded end.
        await applyOwnership(store, slot, ownership, options.recoveryLimit?.(slot.factoryId) ?? 3, options.configLoad?.(slot.factoryId) ?? null);

        return relaunchIfUnexpected(ownership.launchId);
      case "claimed":
        // Same-host pending request whose reply was lost: establish current ownership
        // before classifying the retained diagnostic, and before crash accounting.
        if (ownership.launch.startupDiagnostic !== undefined) {
          await Effect.runPromise(recordLaunch(store, slot, ownership.launch));

          if (await checkStartupCollision(ownership.launch, onUnproven)) {
            await recordGone(ownership.launch);

            return result("held", ownership.launch.launchId);
          }
        }

        // This same host started it for the daemon's pending request; record it, and its end if gone.
        await applyOwnership(store, slot, ownership, options.recoveryLimit?.(slot.factoryId) ?? 3, options.configLoad?.(slot.factoryId) ?? null);

        return ownership.launch.liveness === "live"
          ? result("started", ownership.launch.launchId)
          : relaunchIfUnexpected(ownership.launch.launchId);
      case "frozen":
        // The freeze creates a first-seen slot's record in its own transaction; nothing is adopted.
        onUnproven({
          factoryId: slot.factoryId,
          slotId: slot.slotId,
          cause: ownership.cause,
          evidence: ownership.evidence,
          create: { station: slot.station.address, ordinal: slot.ordinal },
        }, slot);

        return ownership.launchId === null ? result("frozen") : result("frozen", ownership.launchId);
      case "unlaunched":
        // Host-confirmed vacant and never launched: the slot's first launch.
        return launchInto(slot, "started");
    }
  };

  /**
   * Starts a launch in a slot the host has confirmed vacant, opening the slot's current
   * conversation, or a new one if it has none yet.
   */
  const launchInto = async (slot: PlannedSlot, outcome: "started" | "relaunched"): Promise<SlotScheduleResult> => {
    const result = (o: SlotScheduleOutcome, launchId?: string): SlotScheduleResult =>
      launchId === undefined
        ? { factoryId: slot.factoryId, slotId: slot.slotId, outcome: o }
        : { factoryId: slot.factoryId, slotId: slot.slotId, outcome: o, launchId };

    const conversationRef = (await Effect.runPromise(readConversation(store, slot.factoryId, slot.slotId))) ?? randomUUID();
    let args;

    try {
      const slotDir = slotDirectory(options.stateRoot, slot.factoryId, slot.slotId);
      mkdirSync(slotDir, { recursive: true, mode: 0o700 });

      args = buildLaunchArgs(
        {
          model: slot.station.model,
          skills: slot.station.skills,
          extensions: slot.station.extensions,
          foundryExtension: options.foundryExtension,
          slotDir,
          factoryId: slot.factoryId,
          slotId: slot.slotId,
          conversationRef,
        },
        options.pi,
      );
    } catch (cause) {
      return { ...result("refused"), error: messageOf(cause) };
    }

    await Effect.runPromise(recordRequested(store, slot, { hostId: options.hostId, bootId: options.bootId }, conversationRef));
    let launched: LaunchRecord;

    try {
      // The worker dials the instance's channel socket; the host adds the launch identity itself.
      launched = await host.launch({
        factoryId: slot.factoryId,
        slotId: slot.slotId,
        ...args,
        env: { [CHANNEL_SOCKET_ENV]: channelSocketPath(options.stateRoot) },
      });
    } catch (cause) {
      // A refusal proves nothing started. Any other failure (a timeout, a lost connection) may hide a
      // started launch, so the request stays pending and the next start settles it from the host.
      if (cause instanceof HostRefusedError) {await Effect.runPromise(recordRefused(store, slot, cause.reason));}

      return { ...result("refused"), error: messageOf(cause) };
    }

    await Effect.runPromise(recordLaunch(store, slot, launched));

    return result(outcome, launched.launchId);
  };

  type DeferFreeze = (request: FreezeRequest, slot: PlannedSlot) => void;

  const collisionLaunches = new Set<string>();

  const checkStartupCollision = async (launch: LaunchRecord, defer: DeferFreeze): Promise<boolean> => {
    if (launch.startupDiagnostic === undefined || launch.liveness !== "gone") {return false;}

    const slot = options.slots.find((s) => s.factoryId === launch.factoryId && s.slotId === launch.slotId);

    if (slot === undefined || launch.bootId !== options.bootId) {return false;}

    const row = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));
    const recorded = await Effect.runPromise(readLaunch(store, launch.launchId));

    if (row?.current_launch !== launch.launchId || recorded?.factory_id !== slot.factoryId
      || recorded.slot_id !== slot.slotId || recorded.boot_id !== launch.bootId || recorded.pid !== launch.pid) {return false;}

    const expected = expectedToolSet(slot.station, options.foundryExtension);
    const configured = new Set(slot.station.extensions.map((e) => canonicalSource(e.path)));

    const replaced = launch.startupDiagnostic.collisions.flatMap((collision) => {
      const wanted = expected.find((tool) => tool.name === collision.name);

      if (wanted === undefined || canonicalSource(wanted.source) !== canonicalSource(options.foundryExtension)
        || !collision.sources.some((source) => canonicalSource(source) === canonicalSource(wanted.source))) {return [];}

      return collision.sources.filter((source) => configured.has(canonicalSource(source))
        && canonicalSource(source) !== canonicalSource(wanted.source))
        .map((actual) => ({ name: collision.name, expected: wanted.source, actual }));
    });

    if (replaced.length === 0) {return false;}

    collisionLaunches.add(launch.launchId);
    const conversationRef = await Effect.runPromise(readConversation(store, slot.factoryId, slot.slotId));
    const evidence: HoldEvidence = { launchId: launch.launchId, conversationRef: conversationRef ?? "", missing: [], extra: [], replaced };

    if (!options.startupMismatch?.(slot, launch.launchId, evidence)) {
      defer({ ...slot, cause: "tool_set_mismatch", evidence }, slot);
    }

    options.revokeSlot?.(slot.factoryId, slot.slotId);
    // Only the current, host-owned group. Termination still checks descendants
    // after an early loader exit; a reaped leader alone is not group cleanup.
    await options.terminate?.(launch.launchId);

    return true;
  };

  const recordGone = async (launch: LaunchRecord): Promise<boolean> => {
    const end = endOf(launch);

    return end === undefined ? false : Effect.runPromise(recordEnd(store, launch.launchId,
      collisionLaunches.has(launch.launchId) ? { ...end, reason: "requested" } : end,
      options.recoveryLimit?.(launch.factoryId) ?? 3, options.configLoad?.(launch.factoryId) ?? null));
  };

  return {
    schedule: () =>
      scheduleWithFreezes(async (defer) => {
        const inventory = await host.inventory();

        // Ends the host reported while no daemon was listening.
        for (const launch of inventory) {
          if (launch.liveness === "gone") {
            await checkStartupCollision(launch, defer);
            await recordGone(launch);
          }
        }

        const results: Array<SlotScheduleResult> = [];

        for (const slot of options.slots) {results.push(await scheduleSlot(slot, inventory, defer));}

        return results;
      }),
    recheckOwnership: (ref) =>
      serial(async (): Promise<CauseCheckResult> => {
        const slot = options.slots.find((s) => s.factoryId === ref.factoryId && s.slotId === ref.slotId);

        if (slot === undefined) {return { fixed: false, evidence: { reason: "slot_not_configured" } };}

        let inventory: ReadonlyArray<LaunchRecord>;

        try {
          inventory = (await host.inventory()).filter((l) => l.factoryId === ref.factoryId && l.slotId === ref.slotId);
        } catch (error) {
          return { fixed: false, evidence: { reason: "host_inventory_unavailable", error: messageOf(error) } };
        }

        for (const launch of inventory) {
          if (launch.liveness === "gone") {await recordGone(launch);}
        }

        let unproven: FreezeRequest | undefined;
        // This is the operator's ownership check, so it may recover the frozen slot. If the
        // host cannot prove ownership or the recovery fails, the freezer keeps the existing hold.
        const result = await scheduleSlot(slot, inventory, (request) => { unproven = request; }, true);

        if (unproven !== undefined) {return { fixed: false, evidence: unproven.evidence };}

        if (result.outcome === "refused" || result.outcome === "held" || result.outcome === "stopped") {
          return { fixed: false, evidence: { reason: "recovery_not_started", outcome: result.outcome, error: result.error ?? "" } };
        }

        return { fixed: true };
      }),
    recordExit: (launch) => serial(() => recordGone(launch)),
    launchExited: (launch) =>
      scheduleWithFreezes(async (defer): Promise<LaunchExitResult> => {
        // Re-read the current host's inventory: a delayed event is not authority
        // for a different launch, factory, slot or host boot.
        const confirmed = launch.startupDiagnostic === undefined ? launch : (await host.inventory()).find(
          (l) => l.launchId === launch.launchId && l.factoryId === launch.factoryId
            && l.slotId === launch.slotId && l.bootId === launch.bootId,
        );

        if (confirmed === undefined) {return { ended: false };}

        const collision = await checkStartupCollision(confirmed, defer);
        const ended = await recordGone(confirmed);

        if (collision) {return { ended };}

        const slot = options.slots.find((s) => s.factoryId === launch.factoryId && s.slotId === launch.slotId);

        if (!ended || launch.exit === undefined || !exitWasUnexpected(launch.exit) || slot === undefined) {return { ended };}

        // The same checks as scheduling: a frozen slot, a stopping factory or a newer live launch
        // is left alone; only an unexpectedly ended current launch is relaunched.
        try {
          return { ended, recovery: await scheduleSlot(slot, await host.inventory(), defer) };
        } catch (cause) {
          return { ended, recovery: { factoryId: slot.factoryId, slotId: slot.slotId, outcome: "refused", error: messageOf(cause) } };
        }
      }),
    relaunch: (ref, conversationRef) =>
      serial(async () => {
        const slot = options.slots.find((s) => s.factoryId === ref.factoryId && s.slotId === ref.slotId);

        if (slot === undefined) {throw new Error(`slot ${ref.slotId} of factory ${ref.factoryId} is not configured in this run`);}

        if (pendingFreezes.has(slot)) {throw new Error(`slot ${ref.slotId} is being frozen because ownership is unproven`);}

        const inventory = await host.inventory();

        for (const launch of inventory) {
          if (launch.liveness === "gone") {await recordGone(launch);}
        }

        const row = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));

        if (row?.condition === "parked") {throw new Error(`slot ${slot.slotId} is parked; reset is required`);}

        const live = inventory.find((l) => l.factoryId === slot.factoryId && l.slotId === slot.slotId && l.liveness === "live");

        // Never a second worker in a slot: the stopped launch must be gone first.
        if (live !== undefined) {throw new Error(`launch ${live.launchId} is still live in slot ${slot.slotId}`);}

        const current = await Effect.runPromise(readConversation(store, slot.factoryId, slot.slotId));

        // The relaunch continues the frozen conversation, never another one.
        if (current !== conversationRef) {
          throw new Error(`slot ${slot.slotId} is now in conversation ${current ?? "(none)"}, not ${conversationRef}`);
        }

        const started = await launchInto(slot, "relaunched");

        if (started.launchId === undefined) {throw new Error(started.error ?? `slot ${slot.slotId} was not relaunched`);}

        return { launchId: started.launchId };
      }),
    restart: (ref) => serial(async () => {
      const slot = options.slots.find((s) => s.factoryId === ref.factoryId && s.slotId === ref.slotId);

      if (slot === undefined) {throw new SlotsError("slot_not_found", `slot ${ref.slotId} is not configured`);}

      if (options.inScope?.(ref.factoryId) === false || pendingFreezes.has(slot)) {
        return refuseRestart(`slot ${ref.slotId} is stopped or being frozen`);
      }

      const row = await Effect.runPromise(readSlot(store, ref.factoryId, ref.slotId));

      if (row?.condition !== "normal") {return refuseRestart(`slot ${ref.slotId} is not normal; unfreeze or reset it instead`);}

      const inventory = await host.inventory();

      const ownership = await Effect.runPromise(classifySlot(store, ref, {
        hostId: options.hostId, bootId: options.bootId, inventory,
      }));

      if (ownership.kind !== "running") {return refuseRestart(`slot ${ref.slotId} has no proven running launch`);}

      if (options.terminate === undefined) {return refuseRestart("host termination is unavailable");}

      const termination = await options.terminate(ownership.launchId);

      // A reaped leader alone is insufficient: the host must confirm its entire owned group gone.
      if (termination.outcome !== "gone") {return refuseRestart(`process group for launch ${ownership.launchId} is not confirmed gone`);}

      await recordGone(termination.launch);

      // Stop may have begun while termination was in flight. Keep the existing conversation and
      // ended launch on record, but never create a replacement for a stopping factory.
      if (options.inScope?.(ref.factoryId) === false) {return refuseRestart(`factory ${ref.factoryId} is stopping`);}

      const current = await Effect.runPromise(readSlot(store, ref.factoryId, ref.slotId));

      if (current?.condition !== "normal" || pendingFreezes.has(slot)) {return refuseRestart(`slot ${ref.slotId} is held`);}

      options.revokeSlot?.(ref.factoryId, ref.slotId);
      const started = await launchInto(slot, "relaunched");

      if (started.launchId === undefined) {return refuseRestart(started.error ?? `slot ${ref.slotId} was not relaunched`);}

      return { launchId: started.launchId };
    }),
    reset: (ref, force = false) => {
      if (options.freezer.reset === undefined) {return Promise.reject(new Error("reset gate is not configured"));}

      return options.freezer.reset(ref, () => serial(async () => {
        const slot = options.slots.find((s) => s.factoryId === ref.factoryId && s.slotId === ref.slotId);

        if (slot === undefined) {throw new SlotsError("slot_not_found", `slot ${ref.slotId} is not configured`);}

        if (options.inScope?.(ref.factoryId) === false) {throw new SlotsError("reset_refused", `factory ${ref.factoryId} is not running`);}

        if (pendingFreezes.has(slot)) {throw new SlotsError("reset_refused", `slot ${ref.slotId} is being frozen; retry reset`);}

        const row = await Effect.runPromise(readSlot(store, ref.factoryId, ref.slotId));

        if (row === undefined || (row.condition !== "frozen" && row.condition !== "parked")) {
          throw new SlotsError("reset_refused", `slot ${ref.slotId} is not frozen or parked`);
        }

        let confirmed = true;
        let inventory: ReadonlyArray<LaunchRecord> = [];

        try { inventory = (await host.inventory()).filter((l) => l.factoryId === ref.factoryId && l.slotId === ref.slotId); }
        catch { confirmed = false; }

        // Even a reaped leader may have surviving descendants. Ask the owning host to prove the
        // entire group gone, including for inventory entries already marked gone.
        for (const launch of inventory) {
          try {
            if (options.terminate === undefined || (await options.terminate(launch.launchId)).outcome !== "gone") {confirmed = false;}
          } catch { confirmed = false; }
        }

        if (row.current_launch !== null) {
          const current = await Effect.runPromise(readLaunch(store, row.current_launch));

          if (current === undefined || (current.boot_id === options.bootId && !inventory.some((l) => l.launchId === row.current_launch))) {
            confirmed = false;
          }
        }

        if (row.pending_boot === options.bootId && row.pending_host !== null && row.pending_host !== options.hostId) {confirmed = false;}

        if (!confirmed && !force) {throw new SlotsError("reset_refused", `old process group for slot ${ref.slotId} is unconfirmed; use --force to reset`);}

        await Effect.runPromise(store.change((change) => Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const ended = yield* change.query<{ launch_id: string }>(`UPDATE launch SET ended_at = ?, end_reason = 'requested'
            WHERE factory_id = ? AND slot_id = ? AND ended_at IS NULL RETURNING launch_id`, [now, ref.factoryId, ref.slotId]);

          for (const launch of ended) {
            yield* change.recordHistory({ factoryId: ref.factoryId, kind: "launch.ended", subject: launch.launch_id,
              detail: { slotId: ref.slotId, reason: "requested", unexpected: false, reset: true, groupsConfirmedGone: confirmed },
              records: [slotRecord(ref.slotId)] });
          }

          yield* change.query(`UPDATE conversation SET status = 'discarded' WHERE factory_id = ? AND slot_id = ? AND status = 'current'`,
            [ref.factoryId, ref.slotId]);
          // Keep the existing condition and hold until a replacement is durably recorded. A
          // refused/uncertain launch remains gated and can be reset again using host evidence.
          yield* change.query(`UPDATE slot SET current_launch = NULL, pending_host = NULL, pending_boot = NULL
            WHERE factory_id = ? AND slot_id = ?`, [ref.factoryId, ref.slotId]);
          // Preserve binding, IDs and attempts. Only unacknowledged sent messages need re-offering.
          yield* change.query(`UPDATE message SET status = 'bound' WHERE factory_id = ? AND bound_slot = ? AND status IN ('sent', 'indeterminate')`,
            [ref.factoryId, ref.slotId]);

          yield* change.recordHistory({ factoryId: ref.factoryId, kind: "slot.reset_requested", subject: ref.slotId,
            detail: { force, groupsConfirmedGone: confirmed }, records: [slotRecord(ref.slotId)] });
        })));
        // Current launch is now cleared: new claims refuse, and in-flight claims are invalidated.
        options.revokeSlot?.(ref.factoryId, ref.slotId);
        const started = await launchInto(slot, "started");

        if (started.launchId === undefined) {throw new SlotsError("reset_refused", started.error ?? `slot ${ref.slotId} was not launched`);}

        await Effect.runPromise(store.change((change) => Effect.gen(function* () {
          yield* change.query(`UPDATE slot SET condition = 'normal', freeze_cause = NULL, recovery_count = 0
            WHERE factory_id = ? AND slot_id = ?`, [ref.factoryId, ref.slotId]);

          for (const kind of ["parked_slot", "frozen_slot"] as const) {
            yield* closeOpenHoldIn(change, { factoryId: ref.factoryId, kind, subject: ref.slotId }, "resolved");
          }

          yield* change.recordHistory({ factoryId: ref.factoryId, kind: "slot.reset", subject: ref.slotId,
            detail: { force, groupsConfirmedGone: confirmed, launchId: started.launchId }, records: [slotRecord(ref.slotId)] });
        })));

        return { launchId: started.launchId };
      }));
    },
    idle: () => serial(async () => {}),
  };
};

/**
 * Dials the instance's Worker Host, starting one if none answers (PRD §3.2). Callers must hold the
 * state-root claim, so only one starter races for the host socket.
 */
export const connectOrStartHost = async (stateRoot: string): Promise<HostConnection> => {
  try {
    return await connectHost(stateRoot);
  } catch (cause) {
    // Only "nobody answers" means start one; anything else is a real failure to report.
    const code = codeOf(cause);

    if (code !== "ENOENT" && code !== "ECONNREFUSED") {throw cause;}

    await startHost(stateRoot);

    return connectHost(stateRoot);
  }
};

export { SlotsError, type SlotInterrupter, type SlotsErrorCode, type SlotsReader } from "./slots-error.js";

const iso = (ms: number): string => new Date(ms).toISOString();

const decodeCondition = Schema.decodeUnknownSync(SlotCondition);

const decodeFreezeCause = Schema.decodeUnknownSync(Schema.NullOr(FreezeCause));

const toLaunch = (row: LaunchRow): SlotLaunch => ({
  launchId: row.launch_id,
  bootId: row.boot_id,
  pid: row.pid,
  startedAt: iso(row.started_at),
  origin: row.origin,
  endedAt: row.ended_at === null ? null : iso(row.ended_at),
  endReason: row.end_reason,
  exitCode: row.exit_code,
  exitSignal: row.exit_signal,
});

/** The slot as it stands in the store: its condition and its current launch. */
const summaryOf = async (store: Store, slot: PlannedSlot): Promise<SlotSummary> => {
  const row = await Effect.runPromise(readSlot(store, slot.factoryId, slot.slotId));
  const current = row?.current_launch ?? null;
  const launch = current === null ? undefined : await Effect.runPromise(readLaunch(store, current));

  return {
    factoryId: slot.factoryId,
    slotId: slot.slotId,
    station: slot.station.address,
    ordinal: slot.ordinal,
    // Read as stored: a condition this build does not serve yet fails loudly, not as `normal`.
    condition: row === undefined ? "normal" : decodeCondition(row.condition),
    freezeCause: row === undefined ? null : decodeFreezeCause(row.freeze_cause),
    launch: launch === undefined ? null : toLaunch(launch),
  };
};

/** The named factory, or the only one loaded; refuses with `SlotsError` otherwise. */
const resolveFactory = (factories: ReadonlyArray<string>, factory: string | undefined): string => {
  if (factory !== undefined) {
    if (!factories.includes(factory)) {throw new SlotsError("unknown_factory", `No factory "${factory}" is loaded`);}

    return factory;
  }

  const [only] = factories;

  if (factories.length === 1 && only !== undefined) {return only;}

  throw new SlotsError(
    "factory_required",
    factories.length === 0 ? "No factory is loaded" : "More than one factory is loaded; name one with --factory",
  );
};

/** The configured slot a request names; refuses with `SlotsError` when there is none. */
const findSlot = (
  factories: ReadonlyArray<string>,
  slots: ReadonlyArray<PlannedSlot>,
  slotId: string,
  factory: string | undefined,
): PlannedSlot => {
  const factoryId = resolveFactory(factories, factory);
  const slot = slots.find((s) => s.factoryId === factoryId && s.slotId === slotId);

  if (slot === undefined) {throw new SlotsError("slot_not_found", `No slot ${slotId} in factory "${factoryId}"`);}

  return slot;
};

/**
 * The launch the store records as the slot's current, unended one, or `null`. The slot claim
 * accepts a hello only from this launch (PRD §3.2).
 */
export const recordedCurrentLaunch =
  (store: Store) =>
  async (factoryId: string, slotId: string): Promise<string | null> => {
    const current = (await Effect.runPromise(readSlot(store, factoryId, slotId)))?.current_launch ?? null;

    if (current === null) {return null;}

    const launch = await Effect.runPromise(readLaunch(store, current));

    return launch !== undefined && launch.ended_at === null ? current : null;
  };

/**
 * The slot's current conversation as the daemon issued it (PRD §10.1), read afresh, so a changed
 * conversation is still recognized after a daemon restart.
 */
export const storedConversation =
  (store: Store) =>
  (factoryId: string, slotId: string): Promise<string | undefined> =>
    Effect.runPromise(readConversation(store, factoryId, slotId));

/**
 * Serves the configured slots of the started factories from the store, read afresh on each
 * request. Configuration is read only at start, so `slots` is fixed for the run.
 */
export const storeSlotsReader = (
  store: Store,
  stateRoot: string,
  factories: ReadonlyArray<string>,
  slots: ReadonlyArray<PlannedSlot>,
): SlotsReader => ({
  list: async (factory) => {
    if (factory !== undefined) {resolveFactory(factories, factory);}

    const listed: Array<SlotSummary> = [];

    for (const slot of slots) {
      if (factory === undefined || slot.factoryId === factory) {listed.push(await summaryOf(store, slot));}
    }

    return { slots: listed };
  },
  show: async (slotId, factory) => {
    const slot = findSlot(factories, slots, slotId, factory);

    const rows = await Effect.runPromise(
      store.read<LaunchRow>(
        `SELECT ${LAUNCH_COLUMNS} FROM launch WHERE factory_id = ? AND slot_id = ? ORDER BY started_at, rowid`,
        [slot.factoryId, slotId],
      ),
    );

    const launches = rows.map((row): SlotLaunchHistoryEntry => {
      const stderr = launchStderrPath(stateRoot, row.launch_id);

      return { ...toLaunch(row), stderrPath: existsSync(stderr) ? stderr : null };
    });

    return { slot: await summaryOf(store, slot), launches };
  },
});

/** The worker channel's interrupt; a `ChannelServer` satisfies it. */
export type SlotChannel = Pick<ChannelServer, "interrupt">;

export interface SlotInterrupterOptions {
  readonly store: Store;
  readonly factories: ReadonlyArray<string>;
  readonly slots: ReadonlyArray<PlannedSlot>;
  readonly channel: SlotChannel;
  /** Defaults to `SLOT_INTERRUPT_ACK_TIMEOUT_MS`. */
  readonly ackTimeoutMs?: number;
}

/**
 * Interrupts a slot's worker (PRD §5.3) through the authenticated channel's interrupt: the run is
 * aborted, the launch and conversation are kept. Nothing is recorded and nothing is launched or
 * terminated; a worker that does not answer is refused, never restarted.
 */
export const storeSlotInterrupter = (options: SlotInterrupterOptions): SlotInterrupter => {
  const ackTimeoutMs = options.ackTimeoutMs ?? SLOT_INTERRUPT_ACK_TIMEOUT_MS;

  return {
    interrupt: async (slotId, factory) => {
      const slot = findSlot(options.factories, options.slots, slotId, factory);
      const launch = (await summaryOf(options.store, slot)).launch;

      if (launch === null || launch.endedAt !== null) {
        throw new SlotsError("no_live_launch", `Slot ${slotId} has no live launch to interrupt`);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SlotsError("interrupt_unacknowledged", `The worker on launch ${launch.launchId} did not acknowledge the interrupt within ${ackTimeoutMs} ms`)),
          ackTimeoutMs,
        );
      });

      let outcome;

      try {
        outcome = await Promise.race([options.channel.interrupt(launch.launchId), timedOut]);
      } catch (error) {
        if (error instanceof ChannelUnavailableError) {throw new SlotsError("channel_unavailable", `Slot ${slotId}: ${error.message}`);}

        throw error;
      } finally {
        clearTimeout(timer);
      }

      return { launchId: launch.launchId, outcome, slot: await summaryOf(options.store, slot) };
    },
  };
};
