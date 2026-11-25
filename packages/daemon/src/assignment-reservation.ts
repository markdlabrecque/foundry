/** Process-local slot exclusion while an operator settles a worker outside a store transaction.
 * No state has changed yet, so a daemon restart needs no recovery action. A committed outcome
 * may end the old assignment, but scheduling cannot put successor work into the reserved slot.
 */
import type { Store } from "./store.js";

const reservations = new WeakMap<Store, Set<string>>();
const listeners = new WeakMap<Store, Set<() => void>>();

export const onAssignmentSlotReleased = (store: Store, listener: () => void): (() => void) => {
  let callbacks = listeners.get(store);

  if (callbacks === undefined) {
    callbacks = new Set();
    listeners.set(store, callbacks);
  }

  callbacks.add(listener);

  return () => { callbacks.delete(listener); };
};

const keyOf = (factoryId: string, slotId: string): string => JSON.stringify([factoryId, slotId]);

export const isAssignmentSlotReserved = (store: Store, factoryId: string, slotId: string): boolean =>
  reservations.get(store)?.has(keyOf(factoryId, slotId)) ?? false;

/** Acquire synchronously, then re-read assignment identity before any channel I/O. */
export const reserveAssignmentSlot = (store: Store, factoryId: string, slotId: string): (() => void) | undefined => {
  let slots = reservations.get(store);

  if (slots === undefined) {
    slots = new Set();
    reservations.set(store, slots);
  }

  const key = keyOf(factoryId, slotId);

  if (slots.has(key)) {return undefined;}

  slots.add(key);

  return () => {
    slots.delete(key);

    for (const listener of listeners.get(store) ?? []) {listener();}
  };
};
