export interface AssignmentSlot {
  readonly slot_id: string;
  readonly condition: string;
  readonly busy: number;
}

/** Returning work waits for its last slot, even when busy or frozen (PRD §8.2).
 * Callers supply only the current slots of this factory and stage's station, in allocation order. */
export const eligibleAssignmentSlots = (
  slots: ReadonlyArray<AssignmentSlot>,
  previousSlot: string | null,
): ReadonlyArray<AssignmentSlot> => {
  const previous = slots.find((slot) => slot.slot_id === previousSlot);
  const candidates = previous !== undefined && previous.condition !== "parked" ? [previous] : slots;

  return candidates.filter((slot) => slot.condition === "normal" && slot.busy === 0);
};
