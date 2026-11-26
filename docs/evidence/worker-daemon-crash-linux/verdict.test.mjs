// Unit tier: no process, database, filesystem fixture, retries or sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { normalizeText } from "./normalize.mjs";
import { boundedVerdict, guardedPhases, requiredChecks } from "./verdict.mjs";

test("evidence redacts PATH and tokenizes repeated checkout/home prefixes without losing argv order", () => {
  const checkout = `${homedir()}/worktress/develop/t3-123abc-456def`;
  const input = JSON.stringify({ env: { PATH: "/unrelated/bin:/personal/bin" }, argv: [`${checkout}/pi.js`, "--extension", `${checkout}/fixture.ts`], executable: `${homedir()}/node-v22/bin/node` });
  assert.deepEqual(JSON.parse(normalizeText(input)), {
    env: { PATH: "<REDACTED inherited PATH>" }, argv: ["<CHECKOUT>/pi.js", "--extension", "<CHECKOUT>/fixture.ts"], executable: "<USER_HOME>/node-v22/bin/node",
  });
});
const passing = () => Object.fromEntries(requiredChecks.map((key) => [key, true]));
test("all observations pass only the bounded probe, never full ticket acceptance", () => {
  assert.deepEqual(boundedVerdict(passing(), true), {
    outcome: "bounded-pass-not-ticket-acceptance", failedInvariants: [], exitCode: 0, fullTicketAcceptance: false,
  });
});
for (const key of requiredChecks) {
  test(`${key} false or missing cannot be masked by reconnect/traffic/cleanup success`, () => {
    for (const value of [false, undefined]) {
      const verdict = boundedVerdict({ ...passing(), [key]: value }, true);
      assert.equal(verdict.exitCode, 1);
      assert.deepEqual(verdict.failedInvariants, [key]);
      assert.equal(verdict.fullTicketAcceptance, false);
    }
  });
}
test("new recorded invariants also fail closed without editing the required-key list", () => {
  const verdict = boundedVerdict({ ...passing(), futureRecordedInvariant: false }, true);
  assert.equal(verdict.exitCode, 1);
  assert.deepEqual(verdict.failedInvariants, ["futureRecordedInvariant"]);
});
test("missing reconnect is distinguished from data loss and incomplete journeys", () => {
  assert.equal(boundedVerdict({ ...passing(), survivingWorkersReconnected: false, channelTrafficResumed: false }, true).outcome, "blocked-reconnect");
  assert.equal(boundedVerdict({ ...passing(), acceptedRowsAndBindingPreserved: false }, true).outcome, "blocked-invariant");
  assert.equal(boundedVerdict(passing(), false).exitCode, 1);
  assert.equal(boundedVerdict(passing(), false).outcome, "blocked-first-failure");
});
test("stop and copy failures cannot skip marker cleanup, removal or manifest phase", async () => {
  const observed = [];
  const failures = [];
  const errors = await guardedPhases([
    ["stop", () => {throw new Error("stop failed");}],
    ["marker cleanup", () => {observed.push("swept");}],
    ["copy", () => {throw new Error("copy failed");}],
    ["removal", () => {observed.push("removed");}],
    ["manifest", () => {observed.push("written");}],
  ], (failure) => failures.push(failure.phase));
  assert.deepEqual(observed, ["swept", "removed", "written"]);
  assert.deepEqual(failures, ["stop", "copy"]);
  assert.equal(errors.length, 2);
});
