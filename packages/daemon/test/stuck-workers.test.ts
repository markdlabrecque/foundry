// Integration tier: disposable SQLite proves absolute clocks and atomic receipt/hold history.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Effect } from "effect";
import { acknowledgeMessage, createMessageDelivery, createReconciler, detectStuckWorkers, openSlotGate, openStore, recordMessageInjection as persistInjection, startStuckWorkerDetection, STUCK_WORKER_AFTER_MS } from "@foundry/daemon";
import type { Store } from "@foundry/daemon";
import { InjectionReporter } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";

const dirs: Array<string> = [];
const slot = { factoryId: "shop", slotId: "builder/1", launchId: "launch" };
const now = 1_800_000_000_000;
const recordMessageInjection = (store: Store, claimed: typeof slot, id: string) => persistInjection(store, claimed, id, Date.now());

afterEach(async () => {
  vi.useRealTimers();

  for (const dir of dirs.splice(0)) {await rm(dir, { recursive: true, force: true });}
});

const database = async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-stuck-"));
  dirs.push(dir);

  return join(dir, "state.db");
};

const withStore = (filename: string, use: (store: Store) => Promise<void>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(openStore({ filename }), (store) => Effect.promise(() => use(store)))));

const seed = (store: Store) => Effect.runPromise(store.change((change) => Effect.gen(function* () {
  for (const [index, id] of ["injected", "held", "released", "unsent", "offline"].entries()) {
    yield* change.query(`INSERT INTO message (id, factory_id, sequence, sender_slot, recipient, body, delivery,
      kind, status, accepted_at, bound_slot, bound_at) VALUES (?, 'shop', ?, 'sender/1', 'eng.builder', 'body', ?,
      'ordinary', ?, ?, 'builder/1', ?)`,
    [id, index + 1, id === "held" || id === "released" ? "when_idle" : "after_turn", id === "unsent" ? "bound" : "sent", now, now]);

    if (id !== "unsent") {
      yield* change.query(`INSERT INTO message_attempt (id, factory_id, message_id, slot_id, launch_id, connection_id, sent_at)
        VALUES (?, 'shop', ?, 'builder/1', ?, 'connection', ?)`,
      [id, id, id === "offline" ? "old-launch" : "launch", now]);
    }
  }

  yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "messages" });
})));

const holds = (store: Store) => Effect.runPromise(store.read(`SELECT subject, state FROM operator_hold ORDER BY id`));

test("15-minute boundary excludes held when_idle, unsent, prime and disconnected attempts; receipt atomically clears", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await withStore(await database(), async (store) => {
    await seed(store);
    expect(await Effect.runPromise(recordMessageInjection(store, slot, "prime-id"))).toBe(false);
    expect(await Effect.runPromise(recordMessageInjection(store, slot, "unsent"))).toBe(false);
    expect(await Effect.runPromise(recordMessageInjection(store, { ...slot, slotId: "builder/2" }, "injected"))).toBe(false);
    expect(await Effect.runPromise(recordMessageInjection(store, { ...slot, launchId: "other" }, "injected"))).toBe(false);
    expect(await Effect.runPromise(recordMessageInjection(store, slot, "injected"))).toBe(true);
    await Effect.runPromise(recordMessageInjection(store, { ...slot, launchId: "old-launch" }, "offline"));
    const sweep = () => Effect.runPromise(detectStuckWorkers(store, (claimed) => claimed.launchId === slot.launchId));
    vi.setSystemTime(now + STUCK_WORKER_AFTER_MS - 1);
    expect(await sweep()).toBe(0);
    // Repeated injection reports cannot postpone the absolute clock.
    expect(await Effect.runPromise(recordMessageInjection(store, slot, "injected"))).toBe(false);
    vi.setSystemTime(now + STUCK_WORKER_AFTER_MS);
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await holds(store)).toEqual([{ subject: "injected", state: "open" }]);
    expect(await Effect.runPromise(store.read(`SELECT evidence FROM operator_hold`))).toEqual([
      { evidence: JSON.stringify({ messageId: "injected", slot: slot.slotId, launchId: slot.launchId,
        injectedAt: now, unacknowledgedMs: STUCK_WORKER_AFTER_MS }) },
    ]);
    // Time held in the extension does not count, but a released when_idle copy does.
    expect(await Effect.runPromise(recordMessageInjection(store, slot, "released"))).toBe(true);
    vi.setSystemTime(now + 2 * STUCK_WORKER_AFTER_MS - 1);
    expect(await sweep()).toBe(0);
    vi.setSystemTime(now + 2 * STUCK_WORKER_AFTER_MS);
    expect(await sweep()).toBe(1);
    expect(await Effect.runPromise(acknowledgeMessage(store, { ...slot, launchId: "other" }, "injected"))).toBe(false);
    expect(await Effect.runPromise(acknowledgeMessage(store, slot, "injected"))).toBe(true);
    expect(await holds(store)).toEqual([{ subject: "injected", state: "cleared" }, { subject: "released", state: "open" }]);
    expect(await Effect.runPromise(store.read(`SELECT status, acknowledged_at FROM message WHERE id = 'injected'`)))
      .toEqual([{ status: "acknowledged", acknowledged_at: now + 2 * STUCK_WORKER_AFTER_MS }]);
    expect(await Effect.runPromise(store.read(`SELECT acknowledged_at FROM message_attempt WHERE id = 'injected'`)))
      .toEqual([{ acknowledged_at: now + 2 * STUCK_WORKER_AFTER_MS }]);
    expect(await Effect.runPromise(store.read(`SELECT kind, sequence FROM history WHERE subject = 'injected'
      AND kind IN ('message.acknowledged', 'hold.cleared') ORDER BY sequence`)))
      .toMatchObject([{ kind: "hold.cleared", sequence: expect.any(Number) }, { kind: "message.acknowledged", sequence: expect.any(Number) }]);
    expect(await sweep()).toBe(0);
  });
});

test("same-launch absent/idle retry retires the old clock; held and newly injected replacement copies get no false hold", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await withStore(await database(), async (store) => {
    await seed(store);
    await Effect.runPromise(recordMessageInjection(store, slot, "injected"));
    vi.setSystemTime(now + STUCK_WORKER_AFTER_MS);
    const reconciler = createReconciler(store);
    await reconciler.reconcile(slot, { type: "hello", protocolVersion: PROTOCOL_VERSION, ...slot,
      conversationRef: "conversation", hasRecoverableHistory: true, mode: "headless", tools: [] }, {
      send: async (frame) => {
        if (frame.type === "reconcile") {
          reconciler.receive(slot, { type: "reconciliation_answer", requestId: frame.requestId, lifecycle: "idle",
            answers: frame.ids.map((id) => ({ id, status: id === "injected" ? "absent" : "pending" })) });
        }
      },
    });
    expect(await Effect.runPromise(store.read(`SELECT injected_at, retired_at FROM message_attempt WHERE id = 'injected'`)))
      .toEqual([{ injected_at: now, retired_at: now + STUCK_WORKER_AFTER_MS }]);
    // A delayed old report cannot reactivate the retired attempt while awaiting redelivery.
    expect(await Effect.runPromise(persistInjection(store, slot, "injected", now))).toBe(false);
    const errors: Array<unknown> = [];
    const delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => errors.push(cause) });

    try {
      delivery.attach(slot, { send: async () => {} });
      await delivery.idle();
      expect(await Effect.runPromise(detectStuckWorkers(store, () => true))).toBe(0);
      // The replacement stays uninjected (e.g. when_idle held by busy Pi), however old the retired clock gets.
      vi.setSystemTime(now + 2 * STUCK_WORKER_AFTER_MS);
      expect(await Effect.runPromise(detectStuckWorkers(store, () => true))).toBe(0);
      expect(await Effect.runPromise(recordMessageInjection(store, slot, "injected"))).toBe(true);
      vi.setSystemTime(now + 3 * STUCK_WORKER_AFTER_MS - 1);
      expect(await Effect.runPromise(detectStuckWorkers(store, () => true))).toBe(0);
      vi.setSystemTime(now + 3 * STUCK_WORKER_AFTER_MS);
      expect(await Effect.runPromise(detectStuckWorkers(store, () => true))).toBe(1);
      expect(errors).toEqual([]);
    } finally { await delivery.stop(); }
  });
});

test("receipt failure rolls back acknowledgement, attempt and hold together", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await withStore(await database(), async (store) => {
    await seed(store);
    await Effect.runPromise(recordMessageInjection(store, slot, "injected"));
    vi.setSystemTime(now + STUCK_WORKER_AFTER_MS);
    await Effect.runPromise(detectStuckWorkers(store, () => true));
    await Effect.runPromise(store.change((change) => Effect.gen(function* () {
      yield* change.query(`CREATE TRIGGER fail_clear BEFORE UPDATE OF state ON operator_hold
        BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`);
      yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "failure" });
    })));
    await expect(Effect.runPromise(acknowledgeMessage(store, slot, "injected"))).rejects.toBeDefined();
    expect(await holds(store)).toEqual([{ subject: "injected", state: "open" }]);
    expect(await Effect.runPromise(store.read(`SELECT status, acknowledged_at FROM message WHERE id = 'injected'`)))
      .toEqual([{ status: "sent", acknowledged_at: null }]);
    expect(await Effect.runPromise(store.read(`SELECT acknowledged_at FROM message_attempt WHERE id = 'injected'`)))
      .toEqual([{ acknowledged_at: null }]);
  });
});

test("disconnected injection retains its original time and replays after transport success without a daemon commit", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const filename = await database();
  const reporter = new InjectionReporter();
  reporter.record("released");
  await withStore(filename, async (store) => {
    await seed(store);
    // The dying daemon's socket accepted the frame, but it crashed before persistence.
    const transported: Array<unknown> = [];
    reporter.attach({ send: async (frame) => { transported.push(frame); }, close: () => {},
      closed: Promise.resolve() });
    await Promise.resolve();
    expect(transported).toEqual([{ type: "message_injected", id: "released", injectedAt: now }]);
    expect(await Effect.runPromise(store.read(`SELECT injected_at FROM message_attempt WHERE id = 'released'`)))
      .toEqual([{ injected_at: null }]);
  });
  vi.setSystemTime(now + 20 * 60 * 1000);
  await withStore(filename, async (store) => {
    const persisted: Array<Promise<boolean>> = [];
    reporter.attach({ send: async (frame) => {
      if (frame.type === "message_injected") {
        persisted.push(Effect.runPromise(persistInjection(store, slot, frame.id, frame.injectedAt)));
      }
    }, close: () => {}, closed: new Promise<void>(() => {}) });
    expect(await Promise.all(persisted)).toEqual([true]);
    expect(await Effect.runPromise(detectStuckWorkers(store, () => true))).toBe(1);
    expect(await holds(store)).toEqual([{ subject: "released", state: "open" }]);
    expect(await Effect.runPromise(store.read(`SELECT injected_at FROM message_attempt WHERE id = 'released'`)))
      .toEqual([{ injected_at: now }]);
  });
});

test("restart preserves injection time; periodic sweep waits for a live channel and stops on channel loss", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(now);
  const filename = await database();
  await withStore(filename, async (store) => {
    await seed(store);
    await Effect.runPromise(recordMessageInjection(store, slot, "injected"));
  });
  vi.setSystemTime(now + STUCK_WORKER_AFTER_MS);
  await withStore(filename, async (store) => {
    const errors: Array<unknown> = [];
    const detection = startStuckWorkerDetection(store, (cause) => errors.push(cause));

    try {
      expect(await Effect.runPromise(detectStuckWorkers(store, () => false))).toBe(0);
      const lost = detection.accepted(slot);
      lost();
      await vi.advanceTimersByTimeAsync(1000);
      await detection.stop();
      expect(await holds(store)).toEqual([]);
    } finally { await detection.stop(); }

    const restarted = startStuckWorkerDetection(store, (cause) => errors.push(cause));

    try {
      const lostOld = restarted.accepted(slot);
      const lostCurrent = restarted.accepted(slot);
      lostOld(); // A late close from the same launch must not erase its replacement.

      const committed = new Promise<void>((resolve) => {
        const off = store.onCommit(() => { off(); resolve(); });
      });

      await vi.advanceTimersByTimeAsync(1000);
      await committed;
      expect(await holds(store)).toEqual([{ subject: "injected", state: "open" }]);
      lostCurrent();
      // A second injected message must not raise a hold after the current connection closes.
      await Effect.runPromise(recordMessageInjection(store, slot, "released"));
      vi.setSystemTime(now + 2 * STUCK_WORKER_AFTER_MS + 3000);
      await vi.advanceTimersByTimeAsync(1000);
      await restarted.stop();
      expect(await holds(store)).toEqual([{ subject: "injected", state: "open" }]);
      expect(errors).toEqual([]);
    } finally { await restarted.stop(); }
  });
});
