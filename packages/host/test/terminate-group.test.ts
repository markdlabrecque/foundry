// Unit tier: the decision of when to escalate and when to claim "gone" is pure
// logic over injected signal and reap probes; no process is needed to prove it.
import { expect, test } from "vitest";
import { terminateGroup, type GroupSignal } from "@foundry/host";

/** A fake group whose members leave after the signals named in `leavesOn`. */
function fakeGroup(leavesOn: GroupSignal | "never") {
  const sent: GroupSignal[] = [];
  let present = true;
  return {
    sent,
    deps: {
      signalGroup: (_pgid: number, signal: GroupSignal) => {
        if (signal !== 0) sent.push(signal);
        if (signal === leavesOn) present = false;
        // A probe reports whether anyone is left; a real signal reached the group.
        return signal === 0 ? present : true;
      },
      leaderReaped: () => !present,
      sleep: async () => {},
    },
  };
}

const fast = { graceMs: 5, killWaitMs: 5, pollMs: 1 };

test("a group that leaves on SIGTERM is gone without escalation", async () => {
  const group = fakeGroup("SIGTERM");
  expect(await terminateGroup(42, fast, group.deps)).toEqual({ outcome: "gone", escalated: false });
  expect(group.sent).toEqual(["SIGTERM"]);
});

test("a group that ignores SIGTERM is killed and then confirmed gone", async () => {
  const group = fakeGroup("SIGKILL");
  expect(await terminateGroup(42, fast, group.deps)).toEqual({ outcome: "gone", escalated: true });
  expect(group.sent).toEqual(["SIGTERM", "SIGKILL"]);
});

test("a group whose departure is never observed is unconfirmed, not gone", async () => {
  const group = fakeGroup("never");
  expect(await terminateGroup(42, fast, group.deps)).toEqual({ outcome: "unconfirmed", escalated: true });
});

test("a reaped leader with members left in the group is not gone", async () => {
  const sent: GroupSignal[] = [];
  const result = await terminateGroup(42, fast, {
    signalGroup: (_pgid, signal) => {
      if (signal !== 0) sent.push(signal);
      return true;
    },
    leaderReaped: () => true,
    sleep: async () => {},
  });
  expect(result.outcome).toBe("unconfirmed");
  expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
});

test("graceMs 0 kills at once, and an already empty group is never signalled", async () => {
  const group = fakeGroup("SIGKILL");
  expect(await terminateGroup(42, { ...fast, graceMs: 0 }, group.deps)).toEqual({ outcome: "gone", escalated: true });
  expect(group.sent).toEqual(["SIGKILL"]);
  const empty = fakeGroup("never");
  expect(
    await terminateGroup(42, fast, { ...empty.deps, signalGroup: () => false, leaderReaped: () => true }),
  ).toEqual({ outcome: "gone", escalated: false });
  expect(empty.sent).toEqual([]);
});
