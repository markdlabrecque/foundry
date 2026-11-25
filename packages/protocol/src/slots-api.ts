/**
 * Slots over the management API (PRD §5.2, §11.1–§11.2): `foundry slot list | show`.
 *
 * - `GET /api/v1/slots[?factory=<name>]`: a `SlotListResult`, every configured slot of the loaded
 *   factories (or of the named one) with its condition and its latest launch.
 * - `GET /api/v1/slots/<station>/<ordinal>[?factory=<name>]`: a `SlotShowResult`, the slot and its
 *   launch history. `factory` may be left out only when exactly one factory is loaded.
 * - `POST /api/v1/slots/<station>/<ordinal>/interrupt[?factory=<name>]`: a `SlotInterruptResult`.
 *   Aborts the worker's current run over its authenticated channel (PRD §5.3); the launch and
 *   conversation are kept. Answers once the worker acknowledges, with Pi idle again.
 *
 * Slots are addressed as `station/ordinal`, the station's name and a 1-based ordinal.
 */
import { Schema } from "effect";

import { InterruptOutcome } from "./channel.js";
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

export const SLOTS_PATH = `${MANAGEMENT_API_PREFIX}/slots`;

/** Query parameter naming the factory. */
export const SLOT_FACTORY_PARAM = "factory";

/** A slot's ID: its station's name plus its ordinal (PRD §5.2). */
export const slotIdOf = (station: string, ordinal: number): string => `${station}/${ordinal}`;

const SLOT_ID = /^([a-z][a-z0-9-]*)\/([1-9][0-9]{0,5})$/;

/** The station and ordinal of a `station/ordinal` slot ID; `undefined` when it is not one. */
export const parseSlotId = (text: string): { readonly station: string; readonly ordinal: number } | undefined => {
  const match = SLOT_ID.exec(text);

  if (match?.[1] === undefined || match[2] === undefined) {return undefined;}

  return { station: match[1], ordinal: Number(match[2]) };
};

const withFactory = (path: string, factory: string | undefined): string =>
  factory === undefined ? path : `${path}?${new URLSearchParams({ [SLOT_FACTORY_PARAM]: factory }).toString()}`;

/** Request path of the slot list. */
export const slotsPath = (factory?: string): string => withFactory(SLOTS_PATH, factory);

/** Request path of one slot; `slotId` must already be a valid `station/ordinal`. */
export const slotPath = (slotId: string, factory?: string): string => withFactory(`${SLOTS_PATH}/${slotId}`, factory);

/**
 * The slot ID a request path asks for: `undefined` when the path is not a slot route, `null` when
 * it is but does not name a valid `station/ordinal`.
 */
export const matchSlotPath = (path: string): string | null | undefined => {
  const prefix = `${SLOTS_PATH}/`;

  if (!path.startsWith(prefix)) {return undefined;}

  const slotId = path.slice(prefix.length);

  return parseSlotId(slotId) === undefined ? null : slotId;
};

const INTERRUPT_SUFFIX = "/interrupt";

/** How long the daemon waits for the worker's interrupt acknowledgement before it refuses. */
export const SLOT_INTERRUPT_ACK_TIMEOUT_MS = 30_000;

/** Request path of a slot's interrupt; `slotId` must already be a valid `station/ordinal`. */
export const slotInterruptPath = (slotId: string, factory?: string): string =>
  withFactory(`${SLOTS_PATH}/${slotId}${INTERRUPT_SUFFIX}`, factory);

/**
 * The slot ID an interrupt path names: `undefined` when the path is not an interrupt route, `null`
 * when it is but does not name a valid `station/ordinal`.
 */
export const matchSlotInterruptPath = (path: string): string | null | undefined => {
  const prefix = `${SLOTS_PATH}/`;

  // Longer than prefix plus suffix, so `/api/v1/slots/interrupt` is not read as an empty slot ID.
  if (!path.startsWith(prefix) || !path.endsWith(INTERRUPT_SUFFIX) || path.length <= prefix.length + INTERRUPT_SUFFIX.length) {
    return undefined;
  }

  const slotId = path.slice(SLOTS_PATH.length + 1, -INTERRUPT_SUFFIX.length);

  return parseSlotId(slotId) === undefined ? null : slotId;
};

/**
 * A slot's condition (PRD §5.3). `frozen`: the daemon sends it nothing and launches nothing into
 * it until the operator unfreezes or resets it. Parking arrives with its own ticket.
 */
export const SlotCondition = Schema.Literals(["normal", "frozen"]);

export type SlotCondition = typeof SlotCondition.Type;

/** Why a slot is frozen (PRD §5.3), as stable API codes. */
export const FREEZE_CAUSES = [
  "host_lost",
  "unknown_ownership",
  "conversation_changed",
  "prime_without_history",
  "instruction_missing",
  "tool_set_mismatch",
] as const;

export const FreezeCause = Schema.Literals(FREEZE_CAUSES);

export type FreezeCause = typeof FreezeCause.Type;

const SLOT_UNFREEZE = new RegExp(`^${SLOTS_PATH}/([a-z][a-z0-9-]*/[1-9][0-9]{0,5})/unfreeze$`);

/** `POST`: unfreeze a slot once the daemon's re-run of its cause check passes (`foundry slot unfreeze`). */
export const slotUnfreezePath = (slotId: string, factory?: string): string =>
  withFactory(`${SLOTS_PATH}/${slotId}/unfreeze`, factory);

/** The slot an unfreeze request path names; `undefined` when the path is not one. */
export const matchSlotUnfreezePath = (path: string): string | undefined => SLOT_UNFREEZE.exec(path)?.[1];

/**
 * Why a launch is recorded as ended: it `exited` on its own, the host ended it on `requested`
 * termination, or the machine restarted, which a host on a new boot proves (PRD §10.2).
 */
export const LaunchEndReason = Schema.Literals(["exited", "requested", "machine_restarted"]);

export type LaunchEndReason = typeof LaunchEndReason.Type;

/** One launch of a slot as the daemon recorded it from the Worker Host's reports. */
export const SlotLaunch = Schema.Struct({
  launchId: Schema.String,
  /** The machine boot the host started the launch in. */
  bootId: Schema.String,
  pid: Schema.Number,
  /** ISO 8601 time the host started the launch. */
  startedAt: Schema.String,
  /** `started` by this daemon, or `adopted`: found live on the host without a recorded start. */
  origin: Schema.Literals(["started", "adopted"]),
  /** ISO 8601, or `null` while no end is recorded. */
  endedAt: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(LaunchEndReason),
  exitCode: Schema.NullOr(Schema.Number),
  exitSignal: Schema.NullOr(Schema.String),
});

export type SlotLaunch = typeof SlotLaunch.Type;

export const SlotSummary = Schema.Struct({
  factoryId: Schema.String,
  /** `station/ordinal`. */
  slotId: Schema.String,
  /** The station's `room.station` address. */
  station: Schema.String,
  ordinal: Schema.Number,
  condition: SlotCondition,
  /** Why the slot is frozen, or `null` when it is not. */
  freezeCause: Schema.NullOr(FreezeCause),
  /** The slot's latest launch, or `null` if it has never had one. */
  launch: Schema.NullOr(SlotLaunch),
});

export type SlotSummary = typeof SlotSummary.Type;

/** Result of `GET /api/v1/slots`, in factory load order, then configuration order. */
export const SlotListResult = Schema.Struct({
  slots: Schema.Array(SlotSummary),
});

export type SlotListResult = typeof SlotListResult.Type;

/** One entry of a slot's launch history. */
export const SlotLaunchHistoryEntry = Schema.Struct({
  ...SlotLaunch.fields,
  /** The stderr the host kept for a launch that ended unexpectedly, if it is still there. */
  stderrPath: Schema.NullOr(Schema.String),
});

export type SlotLaunchHistoryEntry = typeof SlotLaunchHistoryEntry.Type;

/** Result of `GET /api/v1/slots/<station>/<ordinal>`: the slot and its launches, oldest first. */
export const SlotShowResult = Schema.Struct({
  slot: SlotSummary,
  launches: Schema.Array(SlotLaunchHistoryEntry),
});

export type SlotShowResult = typeof SlotShowResult.Type;

/**
 * Result of `POST /api/v1/slots/<station>/<ordinal>/interrupt`: the launch whose run was
 * interrupted, the worker's answer (`aborted`, or `idle` when no run was active) and the slot as
 * it stands afterwards, still on that launch.
 */
export const SlotInterruptResult = Schema.Struct({
  launchId: Schema.String,
  outcome: InterruptOutcome,
  slot: SlotSummary,
});

export type SlotInterruptResult = typeof SlotInterruptResult.Type;

export const isSlotInterruptResult = Schema.is(SlotInterruptResult);

/** Result of `POST /api/v1/slots/<station>/<ordinal>/unfreeze`: the slot, now normal. */
export const SlotUnfreezeResult = Schema.Struct({
  slot: SlotSummary,
  /** The frozen-slot hold the unfreeze resolved, if one was open. */
  resolvedHold: Schema.NullOr(Schema.Number),
});

export type SlotUnfreezeResult = typeof SlotUnfreezeResult.Type;

export const isSlotUnfreezeResult = Schema.is(SlotUnfreezeResult);

export const isSlotListResult = Schema.is(SlotListResult);

export const isSlotShowResult = Schema.is(SlotShowResult);
