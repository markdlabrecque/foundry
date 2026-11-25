/** Process-local serialization of approval invalidation and its integration consumer. */
import { Semaphore } from "effect";
import type { Store } from "./store.js";

const locks = new WeakMap<Store, Map<string, Semaphore.Semaphore>>();

export const ticketApprovalLock = (store: Store, factory: string, ticket: number): Semaphore.Semaphore => {
  let tickets = locks.get(store);

  if (tickets === undefined) {
    tickets = new Map();
    locks.set(store, tickets);
  }

  const key = JSON.stringify([factory, ticket]);
  let lock = tickets.get(key);

  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    tickets.set(key, lock);
  }

  return lock;
};
