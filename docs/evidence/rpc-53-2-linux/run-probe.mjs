#!/usr/bin/env node
// One-off real-boundary evidence, not a commit-suite test. No operator environment spread.
// Run from repo root: npm ci && npm run build && node docs/evidence/rpc-53-2-linux/run-probe.mjs <output-dir>
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const out = resolve(process.argv[2]);
// Optional SDK evidence route shares the same calibrated fixtures and observations.
const sdk = process.env.FOUNDRY_PROBE_RUNTIME === 'sdk';
mkdirSync(out, { recursive: true });
// Keep socket paths short: caller supplies a short, owned, disk-backed TMPDIR.
const root = mkdtempSync(join(tmpdir(), sdk ? 'f151-' : 'fou97-'));
const user = join(root, 'user'), agent = join(root, 'agent'), markers = join(root, 'markers'), home = join(root, 'state'), source = join(root, 'repo');
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const childTmp = join(root, 'tmp');
for (const dir of [user, agent, markers, source, childTmp]) mkdirSync(dir, { recursive: true });
const env = {
  PATH: process.env.PATH, HOME: user, PI_CODING_AGENT_DIR: agent, TMPDIR: childTmp,
  ...(sdk ? { FOUNDRY_WORKER_RUNTIME: 'sdk' } : {}),
  XDG_CONFIG_HOME: join(user, '.config'), XDG_DATA_HOME: join(user, '.local/share'), XDG_CACHE_HOME: join(user, '.cache'),
  PI_OFFLINE: '1', PI_TELEMETRY: '0', PROBE_MARKER_DIR: markers,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Probe', GIT_AUTHOR_EMAIL: 'probe@foundry.invalid', GIT_COMMITTER_NAME: 'Probe', GIT_COMMITTER_EMAIL: 'probe@foundry.invalid',
  NODE_OPTIONS: `--import=${join(repo, 'docs/evidence/rpc-53-3-linux/fixtures/record-argv.mjs')}${sdk ? ` --import=${join(repo, 'docs/evidence/sdk-53-2-linux/deny-network.mjs')}` : ''}`,
};
const jsonl = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const events = () => jsonl(join(markers, 'events.jsonl'));
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (label, fn, ms = 40000) => { const deadline = Date.now() + ms; while (!fn()) { if (Date.now() > deadline) throw Error('timeout: ' + label); await pause(100); } };
const cliMain = join(repo, 'packages/cli/dist/main.js');
const cli = (...args) => execFileSync(process.execPath, [cliMain, ...args, '--home', home], { env, encoding: 'utf8', timeout: 20000 });
const git = (...args) => execFileSync('git', args, { env, cwd: source });
let daemon, ordinary;
let daemonOutput = '', ordinaryOutput = '';
const result = { root, environment: env, runtime: sdk ? 'sdk' : 'rpc', outcome: 'inconclusive', phase: 'setup' };
// Snapshot only processes bearing this run's unique fixture marker; never signal a
// process/group discovered through a broad executable-name match.
const ownedProcesses = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    if (!entries.includes(`PROBE_MARKER_DIR=${markers}`)) return [];
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return [{ pid: Number(pid), pgid: Number(stat[2]), state: stat[0], slot: entries.find(e => e.startsWith('FOUNDRY_SLOT=')) ?? null, launchId: entries.find(e => e.startsWith('FOUNDRY_LAUNCH_ID=')) ?? null }];
  } catch { return []; } // process exited during snapshot, or another user's unreadable environment
});
try {
  result.versions = { node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), platform: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(), pi: JSON.parse(readFileSync(join(repo, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version, foundry: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() };
  put(join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultTools: ['grep'], defaultProvider: 'wrong-control', defaultModel: 'wrong-control' }));
  if (sdk) put(join(agent, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'none' } }));
  result.fixture = { clearModel: sdk ? 'openai/gpt-4.1-mini' : 'probe-local/inert', clearUnprompted: true, fakeAuth: sdk, denyFetch: sdk };
  put(join(agent, 'models.json'), JSON.stringify({ providers: { 'probe-local': { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'none', models: [{ id: 'inert' }] } } }));
  const markerExtension = (marker) => `import {appendFileSync} from 'node:fs'; export default function(pi) { appendFileSync(${JSON.stringify(join(markers, 'controls.jsonl'))}, JSON.stringify({marker:${JSON.stringify(marker)},slot:process.env.FOUNDRY_SLOT ?? 'ordinary'})+'\\n'); }`;
  put(join(agent, 'extensions/global.ts'), markerExtension('GLOBAL_EXTENSION_53A'));
  put(join(agent, 'AGENTS.md'), 'GLOBAL_CONTEXT_53A\n');
  put(join(agent, 'SYSTEM.md'), 'GLOBAL_SYSTEM_53A\n');
  put(join(agent, 'APPEND_SYSTEM.md'), 'GLOBAL_APPEND_53A\n');
  const mcp = join(root, 'mcp.mjs');
  put(mcp, `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline'; appendFileSync(${JSON.stringify(join(markers, 'mcp-starts.jsonl'))},JSON.stringify({pid:process.pid,slot:process.env.FOUNDRY_SLOT ?? 'ordinary'})+'\\n'); createInterface({input:process.stdin}).on('line',line=>{ const q=JSON.parse(line); if(q.id===undefined)return; const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:q.method==='tools/list'?{tools:[{name:'ambient',description:'MCP_CONTROL_53A',inputSchema:{type:'object',properties:{}}}]}:{}; console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result})); });`);
  put(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [mcp], exposure: 'direct' } } }));
  put(join(source, '.pi/extensions/repository.ts'), markerExtension('REPOSITORY_EXTENSION_53A'));
  put(join(source, '.pi/skills/repository/SKILL.md'), '---\nname: repository-control\ndescription: REPOSITORY_SKILL_53A\n---\nREPOSITORY_BODY_53A\n');
  put(join(source, 'AGENTS.md'), 'REPOSITORY_CONTEXT_53A\n');
  put(join(source, '.pi/SYSTEM.md'), 'REPOSITORY_SYSTEM_53A\n');
  put(join(source, '.pi/settings.json'), JSON.stringify({ defaultTools: ['find'] }));
  put(join(root, 'skill/SKILL.md'), '---\nname: configured-probe\ndescription: CONFIGURED_SKILL_53A\n---\nCONFIGURED_BODY_53A\n');
  git('init', '--quiet', '--initial-branch', 'main'); git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'disposable');
  // Ordinary control is neutral so global defaultTools is not shadowed by project settings.
  result.ordinaryCommand = [process.execPath, join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--mode', 'rpc', '--model', 'probe-faux/scripted', '--extension', join(here, 'fixture.mjs')];
  result.phase = 'ordinary-calibration';
  ordinary = spawn(result.ordinaryCommand[0], result.ordinaryCommand.slice(1), { env, cwd: user, stdio: ['pipe','pipe','pipe'] });
  ordinary.stdout.on('data', c => ordinaryOutput += c); ordinary.stderr.on('data', c => ordinaryOutput += c);
  await until('ordinary MCP discovery', () => jsonl(join(markers, 'mcp-starts.jsonl')).length && events().some(e => e.kind === 'session'));
  ordinary.stdin.write(JSON.stringify({ type: 'prompt', message: 'Observe ordinary control.' }) + '\n');
  await until('ordinary model request', () => events().some(e => e.kind === 'model-request'));
  const control = events().find(e => e.kind === 'model-request');
  assert.match(JSON.stringify(control.context), /GLOBAL_CONTEXT_53A/);
  assert.match(JSON.stringify(control.context), /GLOBAL_SYSTEM_53A/);
  assert.match(JSON.stringify(control.context), /GLOBAL_APPEND_53A/);
  assert.match(JSON.stringify(control.context), /mcp__probe__ambient/);
  assert(events().find(e => e.kind === 'session').active.includes('grep'));
  assert(jsonl(join(markers, 'controls.jsonl')).some(e => e.marker === 'GLOBAL_EXTENSION_53A'));
  ordinary.kill('SIGTERM'); await until('ordinary exit', () => ordinary.exitCode !== null || ordinary.signalCode !== null);
  const fixture = `{ path: ${JSON.stringify(join(here, 'fixture.mjs'))}, tools: [probe_named] }`;
  const yaml = `version: 1\nname: probe\nrepository:\n  source: ./repo\n  default_branch: main\ndefault_production_line: f\ndefaults:\n  model: probe-faux/scripted\n  skills: [./skill/SKILL.md]\n  extensions: [${fixture}]\nrooms:\n  eng:\n    stations:\n      inherit:\n        isolation: worktree\n      skillclear:\n        isolation: worktree\n        skills: []\n      clear:\n        isolation: worktree\n        model: ${result.fixture.clearModel}\n        skills: []\n        extensions: []\nproduction_lines:\n  f:\n    verify: [\"true\"]\n    stages:\n      - id: a\n        station: eng.inherit\n        writing: true\n      - id: b\n        station: eng.skillclear\n      - id: c\n        station: eng.clear\n      - id: approve\n        station: eng.inherit\n        approval: true\n        on_rejection: a\n`;
  put(join(root, 'factory.yaml'), yaml); result.factoryYaml = yaml;
  result.validate = execFileSync(process.execPath, [cliMain, 'validate', join(root, 'factory.yaml')], { env, encoding: 'utf8' });
  result.phase = 'worker-observations';
  daemon = spawn(process.execPath, [join(repo, 'packages/daemon/dist/main.js'), '--home', home, join(root, 'factory.yaml')], { env, stdio: ['ignore','pipe','pipe'] });
  daemon.stdout.on('data', c => daemonOutput += c); daemon.stderr.on('data', c => daemonOutput += c);
  await until('management API', () => daemonOutput.includes('management API on'));
  await until('three accepted channels', () => jsonl(join(home, 'logs/daemon.log')).filter(e => e.msg === 'channel accepted').length === 3);
  await until('two completed faux calls', () => ['inherit/1','skillclear/1'].every(slot => events().filter(e => e.slot === slot && e.kind === 'model-request').length >= 2));
  for (const slot of ['inherit/1', 'skillclear/1']) {
    const requests = events().filter(e => e.slot === slot && e.kind === 'model-request');
    const first = JSON.stringify(requests[0].context);
    assert.match(first, /probe_named/); assert.doesNotMatch(first, /probe_unnamed|GLOBAL_.*53A|REPOSITORY_.*53A|MCP_CONTROL_53A/);
    assert.equal(first.includes('CONFIGURED_SKILL_53A'), slot === 'inherit/1');
    assert.match(JSON.stringify(requests[1].context), /TOOL_RESULT_53A:CALL_MARKER_53A/);
    assert.deepEqual(events().filter(e => e.slot === slot && e.kind === 'tool-executed').map(e => e.name), ['probe_named']);
    const names = requests[0].context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []).map(t => t.name);
    assert(names.includes('read') && names.includes('agent_discover') && names.includes('probe_named'));
    assert(!names.includes('grep') && !names.includes('find') && !names.some(n => n.startsWith('mcp__')));
  }
  const clearLaunchFile = readdirSync(markers).find(n => n.startsWith('clear_1.launch.') && n.endsWith('.json'));
  const clearLaunch = JSON.parse(readFileSync(join(markers, clearLaunchFile), 'utf8'));
  assert(!clearLaunch.argv.includes('--skill') && !clearLaunch.argv.includes(join(here, 'fixture.mjs')));
  const clearHello = jsonl(join(home, 'logs/daemon.log')).find(e => e.msg === 'channel accepted' && e.slotId === 'clear/1');
  // RPC's five-tool expectation is historical, NOT certified against today's base.
  assert.equal(clearHello.detail.tools, sdk ? 12 : 5);
  assert(!events().some(e => e.slot === 'clear/1' && e.kind === 'configured-loaded'));
  assert(jsonl(join(markers, 'controls.jsonl')).every(e => e.slot === 'ordinary'));
  assert(jsonl(join(markers, 'mcp-starts.jsonl')).every(e => e.slot === 'ordinary'));
  result.ownedBeforeShutdown = ownedProcesses();
  result.slots = JSON.parse(cli('slot', 'list', '--json'));
  result.slotDetails = ['inherit/1', 'skillclear/1', 'clear/1'].map(s => cli('slot','show',s,'--json'));
  result.phase = 'observations-complete';
  result.outcome = 'supported';
} catch (error) { result.outcome = 'blocked-on-tested-approaches'; result.failure = error.stack; process.exitCode = 1; }
finally {
  if (ordinary && ordinary.exitCode === null && ordinary.signalCode === null) ordinary.kill('SIGKILL');
  if (daemon) { result.ownedBeforeShutdown ??= ownedProcesses(); try { result.shutdown = cli('shutdown', '--force'); await until('daemon exit', () => daemon.exitCode !== null || daemon.signalCode !== null, 20000); } catch (error) { result.cleanupFailure = String(error); result.outcome = 'inconclusive'; process.exitCode = 1; } }
  await until('owned marked processes exit', () => ownedProcesses().length === 0, 10000).catch(error => { result.cleanupFailure = String(error); });
  result.ownedAfterShutdown = ownedProcesses();
  const ownedGroups = new Set((result.ownedBeforeShutdown ?? []).filter(p => p.pid === p.pgid).map(p => p.pgid));
  result.remainingOwnedGroupMembers = execFileSync('ps', ['-eo', 'pid=,pgid=,stat=,args='], { encoding: 'utf8' }).split('\n').filter(line => ownedGroups.has(Number(line.trim().split(/\s+/)[1])));
  if (result.remainingOwnedGroupMembers.length) result.cleanupFailure = 'Owned group members remain';
  if (result.ownedAfterShutdown.length || result.cleanupFailure) { result.cleanupFailure ??= 'Owned marked processes remain'; result.outcome = 'inconclusive'; process.exitCode = 1; }
  result.daemonOutput = daemonOutput; result.ordinaryOutput = ordinaryOutput;
  result.daemonLog = jsonl(join(home, 'logs/daemon.log'));
  result.hostLog = existsSync(join(home, 'logs/host.log')) ? readFileSync(join(home, 'logs/host.log'), 'utf8') : '';
  const launchLogs = join(home, 'logs/launches');
  result.launchErrors = existsSync(launchLogs) ? Object.fromEntries(readdirSync(launchLogs).map(name => [name, readFileSync(join(launchLogs, name), 'utf8')])) : {};
  result.markers = Object.fromEntries(readdirSync(markers).map(name => [name, readFileSync(join(markers, name), 'utf8')]));
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  // Preserve disposable roots if orderly shutdown failed; never hide owned live processes.
  if (!result.cleanupFailure) rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome: result.outcome, failure: result.failure, cleanupFailure: result.cleanupFailure, output: join(out, 'result.json') }, null, 2));
}
