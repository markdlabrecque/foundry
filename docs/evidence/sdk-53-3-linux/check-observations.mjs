// Manual evidence checker, not a commit-tier test. Exit 1 preserves the unmet gate;
// assertion errors instead mean the recorded observation does not match this report.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(process.argv[2] ?? "docs/evidence/sdk-53-3-linux/results");
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
assert.match(agent.observationError, /every slot's hello/);
assert.match(hold(agent), /kind\s+parked_slot/);
assert.match(hold(agent), /recoveryCount: 3/);
assert.ok(!hold(agent).includes("tool_set_mismatch"));
const exceptions = Object.entries(agent.markers).filter(([k]) => k.endsWith(".exception.log"));
assert.equal(exceptions.length, 3);
for (const [, error] of exceptions) assert.match(error, /SDK extension load failed: .*\/fixtures\/agent-name.ts/);
assert.ok(!Object.keys(agent.markers).some(k => k.endsWith(".session.json")));
const errors = read("loader-errors");
assert.ok(errors.some(e => e.path.endsWith("/fixtures/agent-name.ts") && /Tool "agent_message" conflicts with .*\/packages\/extension\/dist\/index.js/.test(e.error)));
console.log(JSON.stringify({
  observationsVerified: true, zeroFetch: true, cleanupVerified: true,
  missingNamedHold: "verified", reservedNamedHold: "verified", clearedAndInheritedControl: "verified",
  agentCollisionRefusedWithSource: "verified", agentNamedMismatchHold: "unmet: early loader refusal then parked_slot",
  qualification: "blocked on tested implementation; not passed",
}, null, 2));
process.exitCode = 1;
