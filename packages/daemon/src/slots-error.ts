/**
 * The slot routes' reader seam and refusal, kept apart from `slots.ts` so the management API can
 * use them without loading the Worker Host client.
 */
import type { SlotListResult, SlotShowResult } from "@foundry/protocol/slots-api";

export type SlotsErrorCode = "factory_required" | "unknown_factory" | "slot_not_found";

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
