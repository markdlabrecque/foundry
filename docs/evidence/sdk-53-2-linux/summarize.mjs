#!/usr/bin/env node
// Pure evidence analysis plus CLI. A driver exit code/outcome is never qualification.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXED_TOOLS } from '@foundry/protocol';

export function summarize(r) {
  const markers = r.markers ?? {};
  const lines = name => (markers[name] ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  const events = lines('events.jsonl');
  const daemonLog = r.daemonLog ?? [];
  const accepted = slot => daemonLog.some(e => e.msg === 'channel accepted' && e.slotId === slot && e.launchId);
  const launches = slot => Object.entries(markers).filter(([k]) => k.startsWith(slot.replace('/', '_') + '.launch.') && k.endsWith('.json')).map(([,v]) => JSON.parse(v));
  const observations = {};
  const check = (name, fn) => { try { fn(); observations[name] = { status: 'verified' }; } catch (error) { observations[name] = { status: 'unverified', reason: String(error) }; } };
  const verified = name => observations[name]?.status === 'verified';
  const calibration = 'ordinary global controls';
  check(calibration, () => {
    const session = events.find(e => e.slot === 'ordinary' && e.kind === 'session');
    assert(session?.active.includes('grep'), 'missing ordinary session/defaultTools control');
    assert(session.all?.some(t => t.name === 'probe_named') && session.all?.some(t => t.name === 'probe_unnamed'), 'ordinary registry must demonstrate both configured registrations');
    const request = events.find(e => e.slot === 'ordinary' && e.kind === 'model-request');
    assert(request, 'missing ordinary model request');
    const text = JSON.stringify(request.context);
    for (const marker of ['GLOBAL_CONTEXT_53A','GLOBAL_SYSTEM_53A','GLOBAL_APPEND_53A','mcp__probe__ambient']) assert(text.includes(marker), 'missing control: ' + marker);
    assert(lines('controls.jsonl').some(e => e.marker === 'GLOBAL_EXTENSION_53A' && e.slot === 'ordinary'));
    assert(lines('mcp-starts.jsonl').some(e => e.slot === 'ordinary'));
  });
  const workerPrerequisite = slot => {
    assert(verified(calibration), 'ordinary calibration not verified');
    assert(accepted(slot), 'missing accepted worker: ' + slot);
    const requests = events.filter(e => e.slot === slot && e.kind === 'model-request');
    assert(requests.length >= 2, 'missing actual worker model request/result round trip');
    return requests;
  };
  for (const slot of ['inherit/1', 'skillclear/1']) {
    check(slot + ' configured resources, exclusions and real named call', () => {
      const requests = workerPrerequisite(slot);
      const session = events.find(e => e.slot === slot && e.kind === 'session');
      assert.equal(session?.model.provider + '/' + session?.model.id, 'probe-faux/scripted');
      assert(events.some(e => e.slot === slot && e.kind === 'configured-loaded'));
      const first = JSON.stringify(requests[0].context);
      assert.equal(first.includes('CONFIGURED_SKILL_53A'), slot === 'inherit/1');
      assert.doesNotMatch(first, /GLOBAL_.*53A|REPOSITORY_.*53A|MCP_CONTROL_53A|probe_unnamed/);
      const names = requests[0].context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []).map(t => t.name);
      assert.deepEqual(names.toSorted(), [...FIXED_TOOLS, 'probe_named'].toSorted());
      assert.match(JSON.stringify(requests[1].context), /TOOL_RESULT_53A:CALL_MARKER_53A/);
      assert.deepEqual(events.filter(e => e.slot === slot && e.kind === 'tool-executed').map(e => ({ name: e.name, args: e.args })), [{ name: 'probe_named', args: { value: 'CALL_MARKER_53A' } }]);
      assert(requests[1].context.messages.some(m => m.role === 'assistant' && m.content?.some(c => c.type === 'toolCall' && c.name === 'probe_named')), 'missing model-emitted tool call');
    });
  }
  check('global/repository extensions and MCP excluded in connected workers', () => {
    workerPrerequisite('inherit/1'); workerPrerequisite('skillclear/1');
    const controls = lines('controls.jsonl'), mcp = lines('mcp-starts.jsonl');
    assert(controls.length > 0 && mcp.length > 0, 'no calibrated controls');
    assert(controls.every(e => e.slot === 'ordinary'));
    assert(mcp.every(e => e.slot === 'ordinary'));
  });
  check('actual SDK launch and neutral cwd', () => {
    assert.equal(r.environment?.FOUNDRY_WORKER_RUNTIME, 'sdk');
    for (const slot of ['inherit/1','skillclear/1','clear/1']) {
      assert(accepted(slot), 'no accepted SDK worker: ' + slot);
      const records = launches(slot); assert(records.length > 0, 'missing launch argv');
      for (const l of records) { assert(l.argv[0].endsWith('/packages/host/dist/sdk-worker.js')); assert(l.cwd.startsWith(r.root + '/state/slots/')); }
    }
  });
  check('fully cleared inheritance in a connected unprompted station', () => {
    workerPrerequisite('inherit/1'); workerPrerequisite('skillclear/1');
    assert(accepted('clear/1'), 'no accepted clear worker');
    const records = launches('clear/1'); assert(records.length > 0, 'missing clear launch');
    for (const l of records) {
      assert(!l.argv.includes('--skill'));
      assert(!l.argv.some(a => a.endsWith('/rpc-53-2-linux/fixture.mjs')));
      assert.deepEqual(l.argv[l.argv.indexOf('--tools') + 1].split(',').toSorted(), [...FIXED_TOOLS].toSorted());
      assert.equal(l.argv[l.argv.indexOf('--model') + 1], 'openai/gpt-4.1-mini');
    }
    assert(daemonLog.filter(e => e.msg === 'channel accepted' && e.slotId === 'clear/1').every(e => e.detail.tools === FIXED_TOOLS.length));
    assert(!events.some(e => e.slot === 'clear/1'), 'cleared station unexpectedly loaded configured fixture or was prompted');
  });
  check('offline fake-auth fixture and deny-fetch active', () => {
    assert.equal(r.environment?.PI_OFFLINE, '1');
    assert.equal(r.fixture?.fakeAuth, true); assert.equal(r.fixture?.clearUnprompted, true);
    assert.equal(r.fixture?.denyFetch, true);
    const network = lines('network.jsonl'); assert(network.length > 0);
    for (const slot of ['inherit/1','skillclear/1','clear/1']) assert(network.some(e => e.kind === 'deny-fetch-installed' && e.slot === slot));
    assert(!network.some(e => e.kind === 'fetch-denied'), 'unexpected attempted fetch');
  });
  check('owned marked processes and groups cleaned', () => {
    assert(!r.cleanupFailure);
    assert(r.ownedBeforeShutdown?.some(p => p.slot), 'no owned worker identity snapshot');
    assert.deepEqual(r.ownedAfterShutdown, []);
    assert.deepEqual(r.remainingOwnedGroupMembers, []);
  });
  const clearIds = Object.keys(markers).filter(k => /^clear_1\.launch\..*\.json$/.test(k)).map(k => k.slice('clear_1.launch.'.length, -'.json'.length));
  const clearFailures = accepted('clear/1') ? [] : clearIds.map(id => r.launchErrors?.[id + '.stderr']).filter(e => typeof e === 'string' && e.includes('SDK model is not registered:'));
  const complete = Object.values(observations).every(o => o.status === 'verified');
  const outcome = complete ? 'supported' : verified(calibration) && clearFailures.length > 0 ? 'blocked-on-tested-approaches' : 'inconclusive';
  return { outcome, phase: r.phase ?? 'not-recorded', reason: complete ? 'All scoped observations verified; not whole-launcher qualification' : clearFailures.length > 0 ? clearFailures[0] : r.failure ?? 'Missing observation prerequisites; see unverified criteria', observations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = resolve(process.argv[2]);
  const observations = summarize(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')));
  writeFileSync(join(dir, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log(JSON.stringify(observations, null, 2));
  if (observations.outcome !== 'supported') process.exitCode = 1;
}
