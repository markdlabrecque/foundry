/**
 * PRD §10.2 steps 4–5: a slot takes new assignments and stage moves only after its current channel
 * connection has been reconciled and primed in this daemon run. The gate is per slot, so a frozen or
 * slow slot never holds back another one. Work the slot already holds is not gated here; the
 * reconciler resumes it.
 *
 * Each accepted connection closes the slot's gate until that connection is reconciled. When it
 * ends, the gate closes again. A late signal from a replaced connection changes nothing.
 */

export interface GatedConnection {
  /** Reconciliation and the prime finished on this connection; the slot may take new work. */
  readonly reconciled: () => void;
  /** This connection ended; the slot waits for its next connection to reconcile. */
  readonly closed: () => void;
}

export interface ChannelAssignmentGate {
  /** A hello was accepted for the slot. */
  readonly accepted: (slot: { readonly factoryId: string; readonly slotId: string }) => GatedConnection;
  readonly isOpen: (factoryId: string, slotId: string) => boolean;
  /** `listener` runs each time a slot's gate opens. Returns an unsubscribe function. */
  readonly onOpened: (listener: () => void) => () => void;
}

const keyOf = (factoryId: string, slotId: string): string => JSON.stringify([factoryId, slotId]);

export const createChannelAssignmentGate = (): ChannelAssignmentGate => {
  const current = new Map<string, symbol>();
  const open = new Set<string>();
  const listeners = new Set<() => void>();

  return {
    accepted: (slot) => {
      const key = keyOf(slot.factoryId, slot.slotId);
      const connection = Symbol(key);
      current.set(key, connection);
      open.delete(key);

      return {
        reconciled: () => {
          if (current.get(key) !== connection || open.has(key)) {return;}

          open.add(key);

          for (const listener of listeners) {listener();}
        },
        closed: () => {
          if (current.get(key) !== connection) {return;}

          current.delete(key);
          open.delete(key);
        },
      };
    },
    isOpen: (factoryId, slotId) => open.has(keyOf(factoryId, slotId)),
    onOpened: (listener) => {
      listeners.add(listener);

      return () => { listeners.delete(listener); };
    },
  };
};
