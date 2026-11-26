// Candidate observation checker, not a commit-tier test or FOU-153 acceptance closure.
// Retain the historic FOU-153 failure checker unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(process.argv[2] ?? "docs/evidence/sdk-agent-collision-linux/results");
const read = name => JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));
const variants = Object.fromEntries(["missing", "reserved", "cleared", "agent-name"].map(n => [n, read(n)]));
for (const x of Object.values(variants)) {
  assert.equal(x.validate.code, 0);
  assert.equal(x.cleanup.rootRemoved, true);
  assert.equal(x.cleanup.daemonExited, true);
  assert.deepEqual(x.cleanup.remaining, []);
  assert.equal(x.shutdown.code, 0);
  const launches = Object.values(x.markers).filter(m => m?.execPath);
  const networks = Object.entries(x.markers).filter(([k]) => k.endsWith(".network.json"));
  assert.ok(launches.length > 0);
  assert.equal(x.ownedProcesses.length, launches.length);
  assert.deepEqual(x.cleanup.ownedGroups, x.ownedProcesses.map(p => p.pgid));
  for (const p of x.ownedProcesses) {
    assert.equal(p.pid, p.pgid);
    assert.equal(p.runtime, "sdk");
  }
  assert.equal(networks.length, launches.length);
  for (const [, n] of networks) assert.deepEqual(n, { fetchCalls: 0, denied: true });
  for (const m of launches) {
    assert.ok(m.argv[0].endsWith("/packages/host/dist/sdk-worker.js"));
    assert.equal(m.argv[m.argv.indexOf("--model") + 1], "openai/gpt-4.1-mini");
  }
}
const hold = x => x.holdShow.map(h => { assert.equal(h.code, 0); return h.out; }).join("\n");
assert.match(hold(variants.missing), /cause: tool_set_mismatch/);
assert.match(hold(variants.missing), /missing: \[\{"name":"probe_absent","source":".*\/fixtures\/missing.ts"\}\]/);
assert.match(variants.missing.slotList.out, /frozen \(tool_set_mismatch\)/);
assert.match(hold(variants.reserved), /replaced: \[\{"name":"read","expected":"builtin:read","actual":".*\/fixtures\/reserved.ts"\}\]/);
assert.match(variants.reserved.slotList.out, /frozen \(tool_set_mismatch\)/);
const cleared = variants.cleared;
assert.equal(cleared.holdShow.length, 0);
for (const [slot, count] of [["cleared/1", 12], ["inherit/1", 13]]) {
  assert.ok(cleared.daemonLog.some(e => e.msg === "channel accepted" && e.slotId === slot && e.detail.tools === count));
}
const clearedLaunch = Object.values(cleared.markers).find(m => m?.cwd?.endsWith("/cleared-1"));
assert.ok(!clearedLaunch.argv.some(a => a.includes("named.ts") || a.includes("probe_named")));
assert.ok(!Object.keys(cleared.markers).some(k => k.startsWith("cleared_1.named.")));
const inheritedLaunch = Object.values(cleared.markers).find(m => m?.cwd?.endsWith("/inherit-1"));
assert.ok(inheritedLaunch.argv.some(a => a.endsWith("/fixtures/named.ts")));
assert.ok(inheritedLaunch.argv[inheritedLaunch.argv.indexOf("--tools") + 1].split(",").includes("probe_named"));
const inherited = cleared.markers["inherit_1.named.session.json"];
assert.ok(inherited.active.includes("probe_named"));
assert.ok(inherited.all.some(t => t.name === "probe_named" && t.source.endsWith("/fixtures/named.ts")));
const agent = variants["agent-name"];
assert.equal(agent.observationError, undefined);
assert.match(hold(agent), /kind\s+frozen_slot/);
assert.match(hold(agent), /cause: tool_set_mismatch/);
const replacedLine = hold(agent).split("\n").find(line => line.startsWith("  replaced: "));
const replaced = JSON.parse(replacedLine.slice("  replaced: ".length));
assert.equal(replaced.length, 1);
assert.equal(replaced[0].name, "agent_message");
assert.ok(replaced[0].expected.endsWith("/packages/extension/dist/index.js"));
assert.ok(replaced[0].actual.endsWith("/fixtures/agent-name.ts"));
assert.ok(agent.slotList.out.includes("frozen (tool_set_mismatch)"));
assert.equal(agent.failedUnfreeze.code, 1);
assert.match(agent.failedRecheckHold.out, /agent_message/);
assert.ok(agent.failedRecheckHold.out.includes(replaced[0].expected));
assert.ok(agent.failedRecheckHold.out.includes(replaced[0].actual));
assert.ok(!Object.keys(agent.markers).some(k => k.endsWith("agent-name.session.json")));
assert.match(agent.stillFrozenAfterRestart.out, /tool_set_mismatch/);
assert.equal(agent.unfreeze.code, 0);
assert.match(agent.correctedHolds.out, /no open holds/);
const after = JSON.parse(agent.afterCorrection.out).result;
assert.equal(after.slot.condition, "normal");
assert.equal(after.launches.length, 3); // initial collision, failed recheck, corrected recheck only
assert.ok(after.launches.slice(0, 2).every(l => l.endReason === "requested"));
const launches = Object.values(agent.markers).filter(m => m?.execPath);
assert.equal(launches.length, 3);
const conversations = launches.map(m => m.argv[m.argv.indexOf("--session-id") + 1]);
assert.equal(new Set(conversations).size, 1);
assert.match(hold(agent), new RegExp(conversations[0]));
assert.ok(agent.correctedLog.some(e => e.msg === "channel accepted" && e.detail.tools === 13));
const exceptions = Object.entries(agent.markers).filter(([k]) => k.endsWith(".exception.log"));
assert.equal(exceptions.length, 2);
for (const [, error] of exceptions) assert.match(error, /SDK agent tool collision: agent_message: .*index.js, .*agent-name.ts/);
const errors = read("loader-errors");
assert.ok(errors.some(e => e.path.endsWith("/fixtures/agent-name.ts") && /Tool "agent_message" conflicts with .*\/packages\/extension\/dist\/index.js/.test(e.error)));
console.log(JSON.stringify({
  selectedRecordedObservationsChecked: true, zeroFetch: true, cleanupVerified: true,
  missingNamedHold: "verified", reservedNamedHold: "verified", clearedAndInheritedControl: "verified",
  agentCollisionRefusedWithSource: "verified", agentNamedMismatchHold: "verified", correctedSameConversation: "verified", failedRecheckStillFrozen: "verified",
  qualification: "FOU-163 candidate observation only; FOU-153 separate acceptance remains open",
}, null, 2));

