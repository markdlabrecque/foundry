/**
 * `agent_discover` (PRD §6.1): a worker learns its factory's stations and slots. The answer is
 * scoped by the factory of the slot the channel was claimed for, never by anything the worker
 * sends, so one factory's workers cannot see another's configuration (PRD §6.4: routing stays
 * within one factory). It reports configuration only; availability is `agent_status`.
 */
import { Effect } from "effect";
import type { PlannedSlot } from "./slots.js";
import type { ToolHandler } from "./submissions.js";

/** One configured station of the sender's factory, with its slots in ordinal order. */
// Type aliases, not interfaces: only aliases are assignable to `Schema.Json`'s index signature.
export type DiscoveredStation = {
  /** `room.station`. */
  readonly address: string;
  readonly room: string;
  readonly station: string;
  /** `station/ordinal` for each slot. */
  readonly slots: ReadonlyArray<string>;
};

export type DiscoverResult = {
  readonly factory: string;
  readonly stations: ReadonlyArray<DiscoveredStation>;
};

/** The sender factory's stations and slots, in configuration order. */
export const discoverFactory = (slots: ReadonlyArray<PlannedSlot>, factoryId: string): DiscoverResult => {
  const stations = new Map<string, { address: string; room: string; station: string; slots: Array<string> }>();

  for (const slot of slots) {
    if (slot.factoryId !== factoryId) {continue;}

    const { address, room, station } = slot.station;
    const entry = stations.get(address) ?? { address, room, station, slots: [] };
    entry.slots.push(slot.slotId);
    stations.set(address, entry);
  }

  return { factory: factoryId, stations: [...stations.values()] };
};

/**
 * The `agent_discover` handler over this run's configured slots. It only reads, so its sole
 * effect is the submission record the dispatcher writes.
 */
export const agentDiscoverHandler =
  (slots: ReadonlyArray<PlannedSlot>): ToolHandler =>
  (_change, call) =>
    Effect.succeed(discoverFactory(slots, call.factoryId));
