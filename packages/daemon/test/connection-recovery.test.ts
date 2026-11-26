// Tier: unit. Injected recovery operations prove failure/close paths without a store or socket.
import { expect, test } from "vitest";
import { Predicate } from "effect";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { Hello } from "@foundry/protocol";
import { createChannelAssignmentGate } from "../src/channel-assignment-gate.js";
import { recoverConnection } from "../src/connection-recovery.js";
import type { ConnectionRecoveryOptions } from "../src/connection-recovery.js";
import { PrimingOutcome } from "../src/priming.js";

const slot = { factoryId: "shop", slotId: "worker/1", launchId: "launch" };

const hello: Hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, ...slot,
  conversationRef: "conversation", hasRecoverableHistory: true, mode: "headless", tools: [] };

const connection = { send: async () => {} };

const fixture = () => {
  const gate = createChannelAssignmentGate();
  const errors: Array<unknown> = [];
  const warnings: Array<string> = [];
  let attached = false;

  const options: ConnectionRecoveryOptions = {
    gate,
    reconciler: {
      reconcile: async () => ({ history: [], pending: [], absent: [] }),
      resumeAssignment: async () => null,
    },
    primer: { prime: () => ({ connection, outcome: Promise.resolve(PrimingOutcome.Reconnect({})) }) },
    delivery: { attach: () => { attached = true; } },
    notTakingWork: (reason) => warnings.push(reason),
    onError: (cause) => errors.push(cause),
  };

  return { options, gate, errors, warnings, attached: () => attached };
};

test.each(["reconcile", "prime", "resume", "attach"] as const)("%s failure leaves assignments gated and reports the error", async (step) => {
  const f = fixture();
  const cause = new Error(step);

  const fail = async (): Promise<never> => { throw cause; };

  const options: ConnectionRecoveryOptions = {
    ...f.options,
    reconciler: {
      reconcile: step === "reconcile" ? fail : f.options.reconciler.reconcile,
      resumeAssignment: step === "resume" ? fail : f.options.reconciler.resumeAssignment,
    },
    primer: step === "prime" ? { prime: () => ({ connection, outcome: fail() }) } : f.options.primer,
    delivery: step === "attach" ? { attach: () => { throw cause; } } : f.options.delivery,
  };

  await recoverConnection(options, slot, hello, connection);
  expect(f.gate.isOpen(slot.factoryId, slot.slotId)).toBe(false);
  expect(f.errors).toEqual([cause]);
  expect(f.warnings).toEqual([]);
  expect(f.attached()).toBe(false);
});

test.each([PrimingOutcome.Closed(), PrimingOutcome.UnknownStation()])("$_tag prime outcome leaves assignments gated", async (outcome) => {
  const f = fixture();

  await recoverConnection({ ...f.options, primer: { prime: () => ({ connection, outcome: Promise.resolve(outcome) }) } }, slot, hello, connection);
  expect(f.gate.isOpen(slot.factoryId, slot.slotId)).toBe(false);
  expect(f.attached()).toBe(false);
  expect(f.errors).toEqual([]);
  expect(f.warnings).toEqual(Predicate.isTagged(outcome, "Closed") ? [] : [outcome._tag]);
});

test("acceptance closes an already-open gate and a late resumption cannot reopen a closed connection", async () => {
  const f = fixture();

  f.gate.accepted(slot).reconciled();

  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  let resumed!: (value: null) => void;
  const resumption = new Promise<null>((resolve) => { resumed = resolve; });

  const recovery = recoverConnection({ ...f.options,
    reconciler: { ...f.options.reconciler, resumeAssignment: () => resumption },
  }, slot, hello, { ...connection, closed });

  expect(f.gate.isOpen(slot.factoryId, slot.slotId)).toBe(false);
  close();
  await closed;
  resumed(null);
  await recovery;
  expect(f.gate.isOpen(slot.factoryId, slot.slotId)).toBe(false);
  expect(f.errors).toEqual([]);
});
