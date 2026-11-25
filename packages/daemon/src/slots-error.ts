/**
 * The slot routes' reader seam and refusal, kept apart from `slots.ts` so the management API can
 * use them without loading the Worker Host client.
 */
import type { SlotInterruptResult, SlotListResult, SlotShowResult } from "@foundry/protocol/slots-api";

export type SlotsErrorCode =
  | "factory_required"
  | "unknown_factory"
  | "slot_not_found"
  /** The slot has no live launch to interrupt. */
  | "no_live_launch"
  /** No authenticated channel speaks for the slot's launch, or it was lost before the ack. */
  | "channel_unavailable"
  /** The worker did not acknowledge the interrupt in time; the launch is left alone. */
  | "interrupt_unacknowledged";

/** A slot request the daemon refuses, with a stable API code. */
export class SlotsError extends Error {
  override readonly name = "SlotsError";
  constructor(
    readonly code: SlotsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the management API serves for the slot routes. */
export interface SlotsReader {
  /** Every configured slot, or those of the named factory. */
  readonly list: (factory: string | undefined) => Promise<SlotListResult>;
  /** One slot and its launch history; the factory may be left out only when one is loaded. */
  readonly show: (slotId: string, factory: string | undefined) => Promise<SlotShowResult>;
}

/** What the management API serves for `POST .../interrupt` (PRD §5.3). */
export interface SlotInterrupter {
  /** Aborts the slot's current run, keeping its launch and conversation; refuses with `SlotsError`. */
  readonly interrupt: (slotId: string, factory: string | undefined) => Promise<SlotInterruptResult>;
}
