// Disposable real-Pi faux worker. No replacement transport, direct daemon handler or hidden
// idempotency guard: a repeated fresh work call appends another effect and commits again.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { historyBodies, messageText } from './history.mjs';

const probe = process.env.PROBE_DIR;
const record = (kind, detail = {}) => appendFileSync(join(probe, 'worker.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, pid: process.pid, launch: process.env.FOUNDRY_LAUNCH_ID, slot: process.env.FOUNDRY_SLOT, ...detail }) + '\n');
const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();
const textOf = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const field = (text, name) => new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1];

export default function(pi) {
  let current;
  let step = 0;
  const seen = new Set();
  const bodyOf = messageText;
  const configure = (text, bodies) => {
    const assignmentId = field(text, 'Assignment');
    const original = [text, ...bodies].find((body) => field(body, 'Assignment') === assignmentId && field(body, 'Worktree') && field(body, 'Evidence'));
    if (!original) {throw new Error(`No actual original assignment paths for ${assignmentId}`);}
    current = { assignmentId, ticket: Number(/Ticket (\d+)/.exec(original)?.[1]), stage: field(text, 'Stage') ?? field(original, 'Stage'), worktree: field(original, 'Worktree'), evidence: field(original, 'Evidence'), mode: text.includes('The worker was interrupted') ? 'resume' : 'fresh' };
    step = 0;
  };
  const faux = fauxProvider({ provider: 'crash-124', api: 'crash-124-faux', models: [{ id: 'scripted', name: 'Disposable combined-crash acceptance', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] });
  const respond = (context) => {
    faux.appendResponses([respond]);
    record('model-turn', { current, step });
    if (!current) {return fauxAssistantMessage(fauxText('No assigned work in this turn.'));}
    const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args, { id: `crash124-${process.env.FOUNDRY_LAUNCH_ID}-${current.assignmentId}-${step++}` }), { stopReason: 'toolUse' });
    if (current.stage === 'implement' && step === 0) {return call('fixture_work', current);}
    if ((current.stage === 'implement' && step === 1) || (current.stage === 'gate' && step === 0)) {
      return call('task_transition', { assignmentId: current.assignmentId, outcome: 'done', reason: `FOU124 actual ${current.stage} continuation`, evidence: [join(current.evidence, 'continued.json')], gitCommit: git(current.worktree, ['rev-parse', 'HEAD']) });
    }
    return fauxAssistantMessage(fauxText('Tracked outcome submitted; no work replay.'));
  };
  faux.setResponses([respond]);
  pi.registerProvider(faux.provider);
  pi.on('before_agent_start', (event, ctx) => {
    // The immediate actual channel message determines fresh vs recovery intent. Recover paths
    // only from the matching assignment already in Pi's real on-disk conversation branch.
    const message = event.messageType === 'user' ? event.prompt : event.message?.content;
    const text = typeof message === 'string' ? message : Array.isArray(message) ? message.map((b) => b.text ?? '').join('\n') : textOf(message);
    current = undefined; step = 0;
    if (field(text, 'Assignment')) {configure(text, historyBodies(ctx.sessionManager.getBranch()));}
    seen.add(text);
    record('incoming', { text, current });
  });
  // A delivered custom resume notice can join an already-running ordinary-message turn,
  // without another before_agent_start. Observe actual context too, as the existing concurrent
  // fixture does. Track examined history to avoid treating old restored instructions as new.
  pi.on('context', (event) => {
    const bodies = event.messages.map(bodyOf);
    for (const message of event.messages) {
      if (message.role !== 'custom' && message.role !== 'user') {continue;}
      const text = bodyOf(message);
      if (seen.has(text)) {continue;}
      seen.add(text);
      if (field(text, 'Assignment')) {configure(text, bodies);}
      record('incoming', { text, current });
    }
  });
  pi.on('tool_result', (event) => record('tool-result', { event }));
  pi.on('session_start', (_event, ctx) => {
    // Pi persists Foundry custom messages as custom_message entries, not only message entries.
    for (const body of historyBodies(ctx.sessionManager.getBranch())) {seen.add(body);}
    record('launcher', { execPath: process.execPath, argv: process.argv, cwd: process.cwd(), tmpdir: process.env.TMPDIR, effectiveTmpdir: tmpdir(), conversation: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });
  });
  pi.registerTool({
    name: 'fixture_work', label: 'Disposable committed work', description: 'Commit once on fresh assignment; on recovery inspect the existing committed effect; then hold until the evidence operator releases it.',
    parameters: Type.Object({ assignmentId: Type.String(), ticket: Type.Number(), stage: Type.String(), worktree: Type.String(), evidence: Type.String(), mode: Type.Union([Type.Literal('fresh'), Type.Literal('resume')]) }),
    async execute(callId, params, signal) {
      const path = join(params.worktree, `effect-${params.ticket}.txt`);
      record('work-call', { callId, ...params });
      if (params.mode === 'fresh') {
        // Intentionally non-idempotent: accidental replay creates another line and Git commit,
        // independently visible to the driver/verifier. Never suppress a duplicate invocation.
        record('commit-attempt', { callId, ...params });
        appendFileSync(path, `COMMITTED_EFFECT ticket=${params.ticket} assignment=${params.assignmentId}\n`);
        git(params.worktree, ['add', `effect-${params.ticket}.txt`]);
        git(params.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', `FOU124 disposable effect ticket ${params.ticket}`]);
        record('commit', { ...params, sha: git(params.worktree, ['rev-parse', 'HEAD']) });
      } else {
        const body = readFileSync(path, 'utf8');
        if (body !== `COMMITTED_EFFECT ticket=${params.ticket} assignment=${params.assignmentId}\n`) {throw new Error('Recovery inspected unexpected committed effect; not replaying it');}
        record('inspected-existing-commit', { ...params, sha: git(params.worktree, ['rev-parse', 'HEAD']) });
      }
      const sha = git(params.worktree, ['rev-parse', 'HEAD']);
      record('held', { ...params, callId, sha });
      while (!existsSync(join(probe, `release-${params.ticket}`))) {await setTimeout(25, undefined, { signal });}
      const continued = { ...params, sha, pid: process.pid, launch: process.env.FOUNDRY_LAUNCH_ID };
      writeFileSync(join(params.evidence, 'continued.json'), JSON.stringify(continued));
      record('continued', continued);
      return { content: [{ type: 'text', text: JSON.stringify(continued) }], details: continued };
    },
  });
}
