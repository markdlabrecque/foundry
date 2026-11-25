// Unit tier: a store double with no awaiting operations isolates the runner's step order, error
// routing and stop behaviour; the real store and queue are covered in startup-order.test.ts.
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { startFactoryRecovery } from "../src/factory-recovery.js";
import type { RecoveryStep } from "../src/factory-recovery.js";
import type { Store } from "../src/store.js";

// Nothing awaits recovery, so the runner resumes as soon as its steps settle.
const store: Store = {
  filename: "unit-double", schemaVersion: 0,
  read: () => Effect.succeed([]),
  change: () => Effect.die("no writes expected"),
  onCommit: () => () => {},
};

const recording = (events: Array<string>, kind: string, fail?: Error): RecoveryStep => ({
  kind,
  recover: async (factoryId) => {
    events.push(`${kind} ${factoryId}`);

    if (fail !== undefined) {throw fail;}
  },
});

describe("startFactoryRecovery", () => {
  test("runs every step in order, reports a failed step and still resumes", async () => {
    const events: Array<string> = [];
    const errors: Array<[string, string, unknown]> = [];
    const failure = new Error("integration broke");
    let resumed!: () => void;
    const done = new Promise<void>((resolve) => { resumed = resolve; });

    const recovery = startFactoryRecovery({
      store, factories: ["shop"],
      steps: [recording(events, "integration", failure), recording(events, "sync"), recording(events, "cleanup")],
      onRecovered: (factoryId) => { events.push(`resumed ${factoryId}`); resumed(); },
      onError: (factoryId, kind, cause) => errors.push([factoryId, kind, cause]),
    });

    await done;
    await recovery.stop();
    expect(events).toEqual(["integration shop", "sync shop", "cleanup shop", "resumed shop"]);
    expect(errors).toEqual([["shop", "integration", failure]]);
  });

  test("does not resume a factory once stopped", async () => {
    const events: Array<string> = [];
    const errors: Array<unknown> = [];
    let started!: () => void;
    const stepStarted = new Promise<void>((resolve) => { started = resolve; });

    const recovery = startFactoryRecovery({
      store, factories: ["shop"],
      steps: [
        // Held until stop aborts it, as a slow recovery would be.
        { kind: "integration", recover: (_factoryId, signal) => new Promise<void>((resolve) => {
          started();
          signal.addEventListener("abort", () => resolve());
        }) },
        recording(events, "sync"),
      ],
      onRecovered: (factoryId) => { events.push(`resumed ${factoryId}`); },
      onError: (_factoryId, _kind, cause) => errors.push(cause),
    });

    await stepStarted;
    await recovery.stop();
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("stop does not wait for a resumed queue to drain", async () => {
    let resumed!: () => void;
    const resumeStarted = new Promise<void>((resolve) => { resumed = resolve; });

    const recovery = startFactoryRecovery({
      store, factories: ["shop"], steps: [],
      // A queue that never drains.
      onRecovered: () => {
        resumed();

        return new Promise<void>(() => {});
      },
      onError: () => {},
    });

    await resumeStarted;
    await expect(recovery.stop()).resolves.toBeUndefined();
  });

  test("a rejected resume is reported as resume", async () => {
    const failure = new Error("queue broke");

    const reported = new Promise<[string, string, unknown]>((resolve) => {
      startFactoryRecovery({
        store, factories: ["shop"], steps: [],
        onRecovered: () => Promise.reject(failure),
        onError: (factoryId, kind, cause) => resolve([factoryId, kind, cause]),
      });
    });

    expect(await reported).toEqual(["shop", "resume", failure]);
  });
});
