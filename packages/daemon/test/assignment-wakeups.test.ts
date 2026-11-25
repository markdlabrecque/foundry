// Unit tier: controlled commit delivery proves the runner's microtask handoff without SQLite.
import { Effect } from "effect";
import { expect, test } from "vitest";
import { watchAssignments } from "../src/assignments.js";
import type { Change, Store } from "../src/store.js";

// Fixed microtask ordering, not wall-clock waits or retry-until-success.
const microtasks = async (count: number) => {
  for (let i = 0; i < count; i++) {await Promise.resolve();}
};

test.each([0, 1, 2, 3, 4])("a commit %i microtasks after a scan cannot lose its wakeup", async (offset) => {
  let listener: (() => void) | undefined;
  let scans = 0;
  const change: Change = { query: () => Effect.succeed([]), recordHistory: () => Effect.succeed(0) };

  const store: Store = {
    filename: "unit-double", schemaVersion: 0, read: change.query,
    change: (body) => Effect.suspend(() => {
      scans++;

      if (scans === 1) {
        void microtasks(offset).then(() => listener?.());
      }

      return body(change);
    }),
    onCommit: (registered) => {
      listener = registered;

      return () => { listener = undefined; };
    },
  };

  const errors: Array<Error> = [];
  const stop = watchAssignments({ store, factories: [], slots: [] }, (error) => errors.push(error));
  await microtasks(20);
  await stop();
  expect(scans).toBe(2);
  expect(errors).toEqual([]);
  expect(listener).toBeUndefined();
});
