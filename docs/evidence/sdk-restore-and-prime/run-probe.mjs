#!/usr/bin/env node
// Manual real-process wiring evidence only. Reuses the sibling RPC argv recorder.
// Linux only; all commands receive an allowlisted disposable environment.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { connectHost } from '@foundry/host';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'fou148-out-')));
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'fou148-'));
const home = join(root, 'state'), user = join(root, 'user'), agent = join(root, 'agent'), markers = join(root, 'markers'), source = join(root, 'repo');
for (const dir of [user, agent, markers, source]) mkdirSync(dir, { recursive: true });
const env = {
  PATH: process.env.PATH, HOME: user, PI_CODING_AGENT_DIR: agent, TMPDIR: root,
  XDG_CONFIG_HOME: join(user, '.config'), XDG_DATA_HOME: join(user, '.local/share'), XDG_CACHE_HOME: join(user, '.cache'),
  PI_OFFLINE: '1', PI_TELEMETRY: '0', PROBE_DIR: markers, PROBE_MARKER_DIR: markers,
  FOUNDRY_WORKER_RUNTIME: 'sdk', FOUNDRY_HOME: join(root, 'unused'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Probe', GIT_AUTHOR_EMAIL: 'probe@foundry.invalid', GIT_COMMITTER_NAME: 'Probe', GIT_COMMITTER_EMAIL: 'probe@foundry.invalid',
  NODE_OPTIONS: `--import=${join(repo, 'docs/evidence/rpc-53-3-linux/fixtures/record-argv.mjs')}`,
};
const marker = `PROBE_DIR=${markers}`;
const marked = pid => { try { return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker); } catch { return false; } };
const owned = () => readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number).filter(marked);
const ps = () => execFileSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/)).map(([pid, pgid, stat]) => ({ pid: +pid, pgid: +pgid, stat }));
const members = pgid => ps().filter(p => p.pgid === pgid && !p.stat.startsWith('Z'));
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const jsonl = path => read(path).trim().split('\n').filter(Boolean).map(JSON.parse);
const events = () => jsonl(join(markers, 'events.jsonl'));
const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (label, fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error('timeout: ' + label); await pause(100); } };
const cliMain = join(repo, 'packages/cli/dist/main.js');
const cli = (...args) => execFileSync(process.execPath, [cliMain, ...args, '--home', home], { env, encoding: 'utf8', timeout: 30000 });
const queries = sql => { const db = new DatabaseSync(join(home, 'foundry.db'), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const primes = () => queries('SELECT * FROM prime ORDER BY recorded_at');
const result = { root, environment: env, outcome: 'inconclusive', observations: [] };
const observed = (name, detail) => { result.observations.push({ name, detail }); console.log(name); };
let daemon, host, output = '', stage = 'setup';
const signalGroup = (pgid, signal) => {
  const group = members(pgid);
  assert(group.length > 0 && group.every(p => marked(p.pid)), 'refuse to signal unmarked group');
  result.signals ??= []; result.signals.push({ pgid, signal, members: group });
  process.kill(-pgid, signal);
};
try {
  result.versions = { node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), pi: JSON.parse(read(join(repo, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version, platform: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(), foundry: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() };
  const git = (...args) => execFileSync('git', args, { env, cwd: source });
  git('init', '--quiet', '--initial-branch', 'main'); writeFileSync(join(source, 'README.md'), 'Disposable FOU-148\n'); git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
  for (const name of ['factory', 'room', 'station']) writeFileSync(join(root, name + '.md'), name.toUpperCase() + '_INSTRUCTION_148\n');
  const yaml = `version: 1
name: restore
repository:
  source: ./repo
  default_branch: main
default_production_line: f
worktrees:
  root: ${JSON.stringify(join(root, 'worktrees'))}
defaults:
  instructions: ./factory.md
rooms:
  eng:
    instructions: ./room.md
    stations:
      dev:
        isolation: worktree
        instructions: ./station.md
        model: restore-probe/scripted
        extensions:
          - path: ${JSON.stringify(join(repo, 'docs/evidence/sdk-restore-and-prime/fixture.mjs'))}
            tools: [probe_once]
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: build
        station: eng.dev
        writing: true
      - id: approve
        station: eng.dev
        approval: true
        on_rejection: build
`;
  writeFileSync(join(root, 'factory.yaml'), yaml); result.factoryYaml = yaml;
  result.validate = execFileSync(process.execPath, [cliMain, 'validate', join(root, 'factory.yaml')], { env, encoding: 'utf8' });
  result.launchCommand = [process.execPath, join(repo, 'packages/daemon/dist/main.js'), '--home', home, join(root, 'factory.yaml')];
  daemon = spawn(result.launchCommand[0], result.launchCommand.slice(1), { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', c => output += c); daemon.stderr.on('data', c => output += c);
  stage = 'fresh channel and idle prime';
  await until('accepted channel', () => jsonl(join(home, 'logs/daemon.log')).some(e => e.msg === 'channel accepted'));
  host = await connectHost(home);
  const first = (await host.inventory()).find(l => l.liveness === 'live'); result.first = first;
  await until('fresh prime recorded', () => primes().length === 1);
  await pause(1000); // Bounded negative control: idle prime must not start a turn.
  assert.equal(events().filter(e => e.kind === 'model-request').length, 0);
  assert.equal(primes()[0].situation, 'fresh'); assert.equal(primes()[0].acknowledged_at, null);
  const initialSessionFile = events().find(e => e.kind === 'session-start').sessionFile;
  assert(!initialSessionFile || !existsSync(initialSessionFile));
  observed('fresh idle negative control', { primes: primes(), requests: 0, sessionFileExists: false });
  const send = text => cli('message', 'send', 'eng.dev', text, '--factory', 'restore', '--delivery', 'when_idle', '--json');
  stage = 'fresh durable history and side effect';
  result.firstMessage = send('FIRST_148');
  await until('first turn settled and prime acknowledged', () => events().some(e => e.kind === 'agent_settled') && primes()[0].acknowledged_at !== null);
  assert.equal(events().filter(e => e.kind === 'side-effect').length, 1);
  const freshRequest = events().find(e => e.kind === 'model-request');
  assert.match(JSON.stringify(freshRequest.context), /Situation: fresh/);
  for (const name of ['FACTORY', 'ROOM', 'STATION']) assert.match(JSON.stringify(freshRequest.context), new RegExp(name + '_INSTRUCTION_148'));
  observed('fresh prime in actual model history', { primes: primes() });
  stage = 'worker exit and restored recovery';
  signalGroup(first.pgid, 'SIGKILL');
  await until('replacement session', () => events().filter(e => e.kind === 'session-start').length === 2);
  await until('recovery prime', () => primes().length === 2);
  const second = (await host.inventory()).find(l => l.liveness === 'live'); result.second = second;
  assert.notEqual(second.launchId, first.launchId); assert.equal(members(first.pgid).length, 0);
  const starts = events().filter(e => e.kind === 'session-start');
  assert.equal(starts[1].sessionId, starts[0].sessionId); assert.equal(starts[1].sessionFile, starts[0].sessionFile);
  assert.match(JSON.stringify(starts[1].branch), /FIRST_148-call/); assert.match(JSON.stringify(starts[1].branch), /ONCE_RESULT_148/); assert.match(JSON.stringify(starts[1].branch), /DONE_FIRST_148/);
  assert.equal(primes()[1].situation, 'recovery');
  await pause(1000);
  assert.equal(events().filter(e => e.kind === 'side-effect').length, 1);
  assert.equal(events().filter(e => e.pid === second.pid && e.kind === 'model-request').length, 0);
  observed('restoration without automatic execution replay', { oldGroup: members(first.pgid), starts: starts.map(s => ({ pid: s.pid, sessionId: s.sessionId, sessionFile: s.sessionFile })), primes: primes() });
  result.recoveredMessage = send('RECOVERED_148');
  await until('recovered settled', () => events().some(e => e.pid === second.pid && e.kind === 'agent_settled') && primes()[1].acknowledged_at !== null);
  const recovered = events().find(e => e.pid === second.pid && e.kind === 'model-request');
  assert.match(JSON.stringify(recovered.context), /Situation: recovery/); assert.match(JSON.stringify(recovered.context), /ONCE_RESULT_148/);
  const discover = events().find(e => e.pid === second.pid && e.kind === 'tool_execution_end' && e.event.toolName === 'agent_discover');
  assert(discover && !discover.event.isError, 'actual channel tool call must succeed');
  assert.match(JSON.stringify(discover), /restore/);
  assert.equal(events().filter(e => e.kind === 'side-effect').length, 1);
  observed('recovery prime and working authenticated channel', { primes: primes(), discover });
  stage = 'in-place compaction';
  // Default SDK compaction settings retain 20k tokens. Two spans of deterministic
  // padding provide a real cut point without changing product/settings code.
  for (const label of ['PAD_A_148', 'PAD_B_148']) {
    const before = events().filter(e => e.kind === 'agent_settled').length;
    send(label + '\n' + 'z'.repeat(48000));
    await until(label + ' settled', () => events().filter(e => e.kind === 'agent_settled').length === before + 1);
  }
  const turnsBeforeCompact = events().filter(e => e.kind === 'agent_start').length;
  writeFileSync(join(markers, 'compact-request'), 'manual idle compaction');
  await until('compaction complete or error', () => events().some(e => ['compact-complete', 'compact-error'].includes(e.kind)));
  assert(!events().some(e => e.kind === 'compact-error'));
  assert(events().some(e => e.kind === 'session_compact'));
  await until('compaction prime recorded', () => primes().length === 3);
  assert.equal(primes()[2].situation, 'compaction');
  await pause(1000); // Prime alone must not launch a new work turn.
  assert.equal(events().filter(e => e.kind === 'agent_start').length, turnsBeforeCompact);
  assert.equal(events().filter(e => e.kind === 'session_compact').length, 1);
  const before = events().filter(e => e.kind === 'agent_settled').length;
  result.afterCompactMessage = send('AFTER_COMPACT_148');
  await until('post-compaction turn settled and receipt', () => events().filter(e => e.kind === 'agent_settled').length === before + 1 && primes()[2].acknowledged_at !== null);
  const last = events().filter(e => e.kind === 'model-request').at(-1);
  assert.match(JSON.stringify(last.context), /Situation: compaction/);
  assert.equal((await host.inventory()).find(l => l.liveness === 'live').launchId, second.launchId);
  assert.equal(events().filter(e => e.kind === 'session-start').length, 2);
  assert.equal(events().filter(e => e.kind === 'side-effect').length, 1);
  const finalBranch = events().filter(e => e.kind === 'agent_settled').at(-1).branch;
  const injected = finalBranch.filter(e => e.type === 'custom_message' && e.details?.kind === 'prime');
  assert.deepEqual(injected.map(e => /Situation: (\w+)/.exec(e.content)[1]), ['fresh', 'recovery', 'compaction']);
  assert.equal(new Set(injected.map(e => e.content.replace(/Situation: \w+/, 'Situation: <situation>'))).size, 1);
  assert.equal(new Set(primes().map(p => p.parts)).size, 1);
  for (const prime of primes()) {
    assert.equal(prime.conversation_ref, starts[0].sessionId);
    assert(prime.acknowledged_at !== null);
    assert.equal(injected.filter(e => e.details.foundryId === prime.id).length, 1);
  }
  const storedMessages = queries('SELECT * FROM message');
  assert.equal(storedMessages.length, 5);
  assert(storedMessages.every(m => m.status === 'acknowledged'));
  observed('in-place compaction prime in model context', { primes: primes(), live: await host.inventory(), noPrimeStartedTurn: true, identicalBodiesExceptSituation: true });
  result.outcome = 'supported-on-tested-linux-implementation';
} catch (error) {
  result.failure = { stage, error: error.stack };
  result.outcome = 'requires-classification'; process.exitCode = 1;
} finally {
  result.primes = existsSync(join(home, 'foundry.db')) ? primes() : [];
  result.messages = existsSync(join(home, 'foundry.db')) ? queries('SELECT * FROM message') : [];
  result.history = existsSync(join(home, 'foundry.db')) ? queries('SELECT * FROM history ORDER BY sequence') : [];
  if (host) { result.inventoryBeforeShutdown = await host.inventory(); host.close(); }
  try { if (daemon) { result.shutdown = cli('shutdown', '--force'); await until('daemon exit', () => daemon.exitCode !== null || daemon.signalCode !== null); } } catch (error) { result.shutdownError = String(error); }
  result.cleanup = { beforeSweep: owned(), groups: (result.inventoryBeforeShutdown ?? []).map(l => ({ pgid: l.pgid, members: members(l.pgid) })) };
  // Fallback only for still-owned marked groups. Never kill by name or stale PID.
  for (const pgid of new Set(ps().filter(p => marked(p.pid)).map(p => p.pgid))) signalGroup(pgid, 'SIGKILL');
  await until('all marked processes gone', () => owned().length === 0);
  result.cleanup.remaining = owned();
  result.daemonOutput = output; result.daemonLog = jsonl(join(home, 'logs/daemon.log'));
  result.markers = Object.fromEntries(readdirSync(markers).map(name => [name, read(join(markers, name))]));
  const sessions = join(home, 'slots/restore/dev-1/sessions');
  result.sessions = existsSync(sessions) ? Object.fromEntries(readdirSync(sessions).filter(n => n.endsWith('.jsonl')).map(n => [n, read(join(sessions, n))])) : {};
  // Only deterministic padding is abbreviated. All IDs, errors, history, primes,
  // command arguments and tool results remain; no credentials entered this run.
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2).replace(/z{1000,}/g, s => `[deterministic padding: ${s.length} z characters]`));
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome: result.outcome, failure: result.failure, cleanup: result.cleanup, artifact: join(out, 'result.json') }, null, 2));
}
