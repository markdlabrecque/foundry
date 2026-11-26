// Fail-closed acceptance checks on the retained real-process boundary observations.
// Reuse candidate discrepancy/control assertions, then check acceptance-specific
// protocol identity, full snapshots, no generic churn/work and exact launch counts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(process.argv[2] ?? "docs/evidence/sdk-53-3-linux-acceptance/results");
const read = n => JSON.parse(readFileSync(`${dir}/${n}.json`, "utf8"));
execFileSync(process.execPath, ["docs/evidence/sdk-agent-collision-linux/check-observations.mjs", dir], {stdio: "pipe"});
const cli = result => {
  assert.equal(result.code, 0);
  const body = JSON.parse(result.out);
  assert.equal(body.ok, true);
  return body.result;
};
let total = 0;
for (const [name, count] of [["missing", 1], ["reserved", 1], ["cleared", 2], ["agent-name", 3]]) {
  const x = read(name);
  assert.equal(x.observationError, undefined);
  assert.equal(x.cleanupError, undefined);
  assert.equal(x.holdList.code, 0);
  assert.equal(x.slotList.code, 0);
  assert.equal(x.hostIdentity.controlVersion, 5);
  assert.equal(x.hostIdentity.stateRoot, `${x.root}/home`);
  assert.ok(x.hostIdentity.pid > 0);
  assert.equal(x.hostInventory.length, name === "cleared" ? 2 : 1);
  assert.deepEqual(cli(x.ticketList).tickets, []);
  assert.ok(Array.isArray(x.fullDaemonLog) && x.fullDaemonLog.length > 0);
  assert.ok(!x.fullDaemonLog.some(e => /relaunch|park|assignment|deliver/i.test(e.msg)));
  assert.equal(x.slotJson.length, name === "cleared" ? 2 : 1);
  for (const snapshot of x.slotJson) {
    const {slot, launches} = cli(snapshot);
    assert.equal(slot.condition, name === "cleared" ? "normal" : "frozen");
    if (name !== "cleared") {
      assert.equal(slot.freezeCause, "tool_set_mismatch");
      assert.equal(launches.length, 1);
      assert.equal(launches[0].endReason, "requested");
    }
  }
  const launchMarkers = Object.values(x.markers).filter(v => v?.execPath);
  assert.equal(launchMarkers.length, count);
  total += launchMarkers.length;
  for (const marker of launchMarkers) {
    const argv = marker.argv;
    const ext = argv.filter((_, i) => argv[i - 1] === "--extension");
    assert.ok(ext[0].endsWith("/packages/extension/dist/index.js"));
    assert.ok(argv.includes("--no-extensions") && argv.includes("--no-context-files"));
  }
  if (name !== "cleared") {
    assert.match(x.holdList.out, /frozen_slot/);
    assert.ok(!x.holdList.out.includes("parked_slot"));
    for (const record of x.hostInventory) assert.equal(record.liveness, "gone");
  }
}
assert.equal(total, 7);
const agent = read("agent-name");
const diagnostic = agent.hostInventory[0].startupDiagnostic;
assert.equal(diagnostic.kind, "agent_tool_collision");
assert.equal(diagnostic.collisions[0].name, "agent_message");
assert.ok(diagnostic.collisions[0].sources.some(s => s.endsWith("/fixtures/agent-name.ts")));
assert.ok(diagnostic.collisions[0].sources.some(s => s.endsWith("/packages/extension/dist/index.js")));
assert.equal(agent.correctedFactoryYaml, agent.factoryYaml.replace("agent-name.ts", "named.ts"));
const before = cli(agent.beforeCorrection);
assert.equal(before.slot.condition, "frozen");
assert.equal(before.launches.length, 2);
assert.ok(before.launches.every(l => l.endReason === "requested"));
const after = cli(agent.afterCorrection);
assert.equal(after.launches.length, 3);
assert.equal(new Set(after.launches.map(l => l.bootId)).size, 1);
assert.equal(after.slot.condition, "normal");
assert.equal(after.slot.freezeCause, null);
assert.equal(after.slot.launch.endedAt, null);
assert.ok(!agent.correctedLog.some(e => /relaunch|park|assignment|deliver/i.test(e.msg)));
console.log(JSON.stringify({
  outcome: "supported on Linux for the listed FOU-153 actual-host observations",
  requiredNamedSourceHolds: ["probe_absent", "read", "agent_message"],
  clearedAndInheritedControl: true, unchangedUnfreezeRefused: true,
  correctedUnfreezeSameConversationReference: true, hostControlVersion: 5,
  launches: total, interceptedFetchAttempts: 0, allOwnedGroupsAndRootsCleaned: true,
  noGenericChurnOrAssignedWorkObserved: true,
  limits: "No prompts/tickets, no prompted-history restoration, no OS-wide network isolation, no macOS or complete-launcher qualification; independent review pending",
}, null, 2));
