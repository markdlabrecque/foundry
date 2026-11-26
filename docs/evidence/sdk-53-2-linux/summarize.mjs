#!/usr/bin/env node
// Post-process retained observations; never launches or invokes a tool implementation.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const dir = resolve(process.argv[2]);
const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
const events = r.markers['events.jsonl'].trim().split('\n').map(JSON.parse);
const lines = name => (r.markers[name] ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
const observations = {};
const check = (name, fn) => { try { fn(); observations[name] = 'verified'; } catch (error) { observations[name] = { status: 'unverified', error: String(error) }; } };
check('actual SDK host selection', () => {
  assert.equal(r.environment.FOUNDRY_WORKER_RUNTIME, 'sdk');
  const launches = Object.entries(r.markers).filter(([k]) => /\.launch\..*\.json$/.test(k)).map(([,v]) => JSON.parse(v));
  assert(launches.length >= 3);
  for (const l of launches) { assert(l.argv[0].endsWith('/packages/host/dist/sdk-worker.js')); assert(l.cwd.startsWith(r.root + '/state/slots/')); }
});
check('ordinary global extension/MCP/context/defaultTools calibration', () => {
  const session = events.find(e => e.slot === 'ordinary' && e.kind === 'session');
  assert(session.active.includes('grep'));
  const text = JSON.stringify(events.find(e => e.slot === 'ordinary' && e.kind === 'model-request').context);
  for (const marker of ['GLOBAL_CONTEXT_53A','GLOBAL_SYSTEM_53A','GLOBAL_APPEND_53A','mcp__probe__ambient']) assert(text.includes(marker));
  assert(lines('controls.jsonl').some(e => e.marker === 'GLOBAL_EXTENSION_53A' && e.slot === 'ordinary'));
  assert(lines('mcp-starts.jsonl').some(e => e.slot === 'ordinary'));
});
for (const slot of ['inherit/1','skillclear/1']) {
  check(slot + ': configured model/resources and excluded ambient resources', () => {
    const session = events.find(e => e.slot === slot && e.kind === 'session');
    assert.equal(session.model.provider + '/' + session.model.id, 'probe-faux/scripted');
    assert(events.some(e => e.slot === slot && e.kind === 'configured-loaded'));
    const requests = events.filter(e => e.slot === slot && e.kind === 'model-request');
    const first = JSON.stringify(requests[0].context);
    assert.equal(first.includes('CONFIGURED_SKILL_53A'), slot === 'inherit/1');
    assert.doesNotMatch(first, /GLOBAL_.*53A|REPOSITORY_.*53A|MCP_CONTROL_53A|probe_unnamed/);
    const names = requests[0].context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []).map(t => t.name);
    assert.equal(names.length, 13);
    assert(names.includes('probe_named') && names.includes('read') && names.includes('agent_discover'));
    assert(!names.includes('grep') && !names.includes('find') && !names.some(n => n.startsWith('mcp__')));
    assert.match(JSON.stringify(requests[1].context), /TOOL_RESULT_53A:CALL_MARKER_53A/);
    assert.deepEqual(events.filter(e => e.slot === slot && e.kind === 'tool-executed').map(e => e.name), ['probe_named']);
    assert(r.daemonLog.some(e => e.msg === 'channel accepted' && e.slotId === slot));
  });
}
check('global/repository extensions and MCP never loaded in workers', () => {
  assert(lines('controls.jsonl').every(e => e.slot === 'ordinary'));
  assert(lines('mcp-starts.jsonl').every(e => e.slot === 'ordinary'));
});
check('cleared extension/skill argv and no configured extension startup', () => {
  const launches = Object.entries(r.markers).filter(([k]) => /^clear_1\.launch\..*\.json$/.test(k));
  assert.equal(launches.length, 3);
  for (const [,value] of launches) { const l = JSON.parse(value); assert(!l.argv.includes('--skill')); assert(!l.argv.some(a => a.endsWith('/rpc-53-2-linux/fixture.mjs'))); }
  assert(!events.some(e => e.slot === 'clear/1'));
});
check('reproducible clear-station failure', () => {
  assert.equal(Object.values(r.launchErrors).length, 3);
  for (const err of Object.values(r.launchErrors)) assert.match(err, /SDK model is not registered: probe-local\/inert/);
  assert(!r.daemonLog.some(e => e.msg === 'channel accepted' && e.slotId === 'clear/1'));
});
check('owned marked processes cleaned', () => { assert(!r.cleanupFailure); assert(r.ownedBeforeShutdown.some(p => p.slot)); assert.deepEqual(r.ownedAfterShutdown, []); });
observations['fully cleared station connects without extension/tools'] = 'unmet: no registered fixture model; no accepted hello';
observations['gate outcome'] = 'blocked-on-tested-approaches; passing criterion remains unmet, SDK capability inconclusive';
writeFileSync(join(dir, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
console.log(JSON.stringify(observations, null, 2));
