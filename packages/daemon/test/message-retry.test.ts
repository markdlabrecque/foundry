// Tier: unit. The full PRD §6.3 decision table needs no channel, Pi or database.
import { expect, test } from "vitest";
import { decideMessageRetry } from "@foundry/daemon";
import type { RetryDecision, RetryEvidence } from "@foundry/daemon";

const absence: ReadonlyArray<readonly [RetryEvidence["launch"], RetryEvidence["lifecycle"], RetryDecision]> = [
  ["same", "idle", "retry"],
  ["same", "working", "recheck_when_idle"],
  ["same", "unknown", "indeterminate"],
  ["replacement", "idle", "retry"],
  ["replacement", "working", "retry"],
  ["replacement", "unknown", "retry"],
  ["unknown", "idle", "indeterminate"],
  ["unknown", "working", "indeterminate"],
  ["unknown", "unknown", "indeterminate"],
];

test.each(absence)("absent, launch %s, lifecycle %s => %s", (launch, lifecycle, expected) => {
  expect(decideMessageRetry({ status: "absent", launch, lifecycle })).toBe(expected);
});

test.each(absence)("history/pending exclude retry for launch %s, lifecycle %s", (launch, lifecycle) => {
  expect(decideMessageRetry({ status: "history", launch, lifecycle })).toBe("acknowledge");
  expect(decideMessageRetry({ status: "pending", launch, lifecycle })).toBe("leave_pending");
});
