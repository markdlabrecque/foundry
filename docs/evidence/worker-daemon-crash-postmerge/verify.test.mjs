// Unit tier: literal observations and negative mutations, no processes/DB/filesystem/sleeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuationChecks, requiredChecks, sameUid, verdict } from './verify.mjs';
import { historyBodies } from './history.mjs';

test('restored custom_message history remains observed history, not a new fresh assignment', () => {
  const original = 'Assignment: a1\nWorktree: /fixture/worktree\nEvidence: /fixture/evidence';
  const branch = [{ type: 'custom_message', content: original }, { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'prior' }] } }];
  assert.deepEqual(historyBodies(branch), [original, 'prior']);
  assert.ok(new Set(historyBodies(branch)).has(original));
});

test('ownership observation accepts real tab-delimited proc Uid and rejects missing/different uid', () => {
  assert.equal(sameUid('Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n', 1000), true);
  assert.equal(sameUid('Uid: 1000 1000 1000 1000\n', 1000), true);
  assert.equal(sameUid('Uid:\t1001\t1001\t1001\t1001\n', 1000), false);
  assert.equal(sameUid('Name:\tnode\n', 1000), false);
});
function observed() {
  const before = { assignment: [1, 2].map((n) => ({ id: `a${n}`, ticket_number: n, stage: 'implement', slot_id: `dev/${n}`, context_message: `m${n}`, status: 'active' })), message: [1, 2].map((n) => ({ id: `m${n}`, body: `assignment ${n}`, recipient: 'eng.dev', bound_slot: `dev/${n}` })) };
  before.message.push(...['FOU124_BEFORE_WORKER', 'FOU124_BEFORE_DAEMON'].map((body, n) => ({ id: `o${n}`, body, recipient: 'eng.dev', bound_slot: 'dev/1' })));
  before.launch = ['original', 'survivor', 'replacement'].map((launch_id) => ({ launch_id }));
  const after = {
    launch: structuredClone(before.launch),
    message: before.message.map((m) => ({ ...m, status: 'acknowledged' })),
    assignment: [...before.assignment.map((a) => ({ ...a, status: 'ended', end_reason: 'done' })), ...[1, 2].map((n) => ({ id: `gate${n}`, ticket_number: n, stage: 'gate', status: 'ended', end_reason: 'done' }))],
    ticket: [1, 2].map((number) => ({ number, state: 'stage', stage: 'gate', status: 'awaiting_approval' })),
    ticket_transition: [1, 2].flatMap((ticket_number) => ['implement', 'gate'].map((from_stage) => ({ ticket_number, from_stage, outcome: 'done' }))),
    approval: [1, 2].map((ticket_number) => ({ ticket_number, kind: 'stage_gate', state: 'open' })),
    submission: [],
  };
  const workerEvents = [1, 2].flatMap((ticket) => ['commit-attempt', 'commit', 'continued'].map((kind) => ({ kind, ticket, assignmentId: `a${ticket}`, sha: `sha${ticket}`, at: '2026-11-26T00:00:02Z', launch: ticket === 1 ? 'replacement' : 'survivor' })));
  workerEvents.push(...before.message.slice(2).map((m) => ({ kind: 'incoming', text: m.body })), ...[1, 2, 3, 4].map(() => ({ kind: 'tool-result', event: { toolName: 'task_transition', isError: false } })));
  const git = [1, 2].map((number) => ({ number, base: 'base', head: `sha${number}`, commits: [`sha${number}`], body: `COMMITTED_EFFECT ticket=${number} assignment=a${number}\n` }));
  const artifactsBefore = [1, 2].map((number) => ({ number, specHash: `spec${number}`, worktree: { path: `path${number}`, startCommit: 'base' }, head: `sha${number}` }));
  for (const a of before.assignment) { a.factory_id = 'alpha'; }
  before.ticket = [1, 2].map((number) => ({ number, factory_id: 'alpha', start_commit: 'base' }));
  for (const launch of [...before.launch, ...after.launch]) { Object.assign(launch, { factory_id: 'alpha', slot_id: launch.launch_id === 'survivor' ? 'dev/2' : 'dev/1' }); }
  for (const ticket of after.ticket) { Object.assign(ticket, { factory_id: 'alpha', start_commit: 'base' }); }
  after.message.push(...[1, 2].map((n) => ({ id: `gm${n}`, body: `Ticket ${n}\nStage: gate\nAssignment: gate${n}\nSlot: dev/${n}`, recipient: 'eng.dev', bound_slot: `dev/${n}`, status: 'acknowledged' })));
  for (const a of after.assignment) {
    const n = a.ticket_number; Object.assign(a, { factory_id: 'alpha', slot_id: `dev/${n}`, context_message: a.stage === 'gate' ? `gm${n}` : `m${n}` });
    const message = after.message.find((m) => m.id === a.context_message);
    Object.assign(message, { factory_id: 'alpha', ticket_number: n, body: `Ticket ${n}\nStage: ${a.stage}\nAssignment: ${a.id}\nSlot: ${a.slot_id}` });
    const initialMessage = before.message.find((m) => m.id === message.id);
    if (initialMessage) { Object.assign(initialMessage, { ...message, status: 'sent' }); }
    const transition = after.ticket_transition.find((t) => t.ticket_number === n && t.from_stage === a.stage);
    Object.assign(transition, { sequence: a.stage === 'implement' ? n : n + 2, factory_id: 'alpha', actor: a.slot_id, git_commit: `sha${n}`, to_state: 'stage', to_stage: 'gate', to_status: a.stage === 'implement' ? 'queued' : 'awaiting_approval' });
    const approval = after.approval.find((r) => r.ticket_number === n);
    Object.assign(approval, { id: n, factory_id: 'alpha', assignment_id: `gate${n}`, transition_sequence: n + 2 });
    const value = { assignmentId: a.id, ticket: n, stage: 'gate', status: transition.to_status, ...(a.stage === 'gate' ? { approvalId: n } : {}) };
    const launch = n === 1 ? 'replacement' : 'survivor'; const callId = `call-${a.id}`;
    after.submission.push({ tool: 'task_transition', launch_id: launch, call_id: callId, factory_id: 'alpha', slot_id: a.slot_id, result: JSON.stringify(value) });
    workerEvents.push({ kind: 'tool-result', launch, slot: a.slot_id, event: { toolName: 'task_transition', toolCallId: callId, input: { assignmentId: a.id, outcome: 'done', gitCommit: `sha${n}` }, details: { status: 'committed', value }, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } });
  }
  // Replace the old count-only placeholders with faithful real tool-result observations.
  const events = workerEvents.filter((e) => e.kind !== 'tool-result' || e.event.toolCallId);
  return { before, after, workerEvents: events, git, artifactsBefore, artifactsAfter: structuredClone(artifactsBefore), releasedAt: '2026-11-26T00:00:01Z', liveLaunchIds: ['survivor', 'replacement'] };
}
test('completed independent Git effects plus actual continuation/store outcomes satisfy the observation oracle', () => {
  const checks = continuationChecks(observed());
  assert.equal(Object.keys(checks).length, 9);
  assert.ok(Object.values(checks).every((v) => v === true));
});
const negatives = [
  ['lost accepted message', (x) => x.after.message.shift(), 'acceptedWorkRetained'],
  ['changed accepted body', (x) => { x.after.message[0].body = 'wrong'; }, 'acceptedWorkRetained'],
  ['rerouted existing binding', (x) => { x.after.message[0].bound_slot = 'dev/2'; }, 'acceptedWorkRetained'],
  ['unacknowledged retained row', (x) => { x.after.message[0].status = 'sent'; }, 'acceptedWorkRetained'],
  ['duplicate ordinary effect', (x) => x.after.message.push({ ...x.after.message[2], id: 'duplicate' }), 'ordinaryMessagesProcessed'],
  ['no actual ordinary processing', (x) => { x.workerEvents = x.workerEvents.filter((e) => e.kind !== 'incoming'); }, 'ordinaryMessagesProcessed'],
  ['changed artifact', (x) => { x.artifactsAfter[0].specHash = 'wrong'; }, 'artifactBindingsUnchanged'],
  ['lost original assignment', (x) => x.after.assignment.shift(), 'originalAssignmentsHonored'],
  ['rerouted original assignment', (x) => { x.after.assignment[0].slot_id = 'dev/2'; }, 'originalAssignmentsHonored'],
  ['ticket never progresses', (x) => { x.after.ticket[0].status = 'assigned'; }, 'trackedTicketsContinued'],
  ['duplicate outcome transition', (x) => x.after.ticket_transition.push({ ...x.after.ticket_transition[0] }), 'trackedTicketsContinued'],
  ['no operator handoff', (x) => x.after.approval.pop(), 'trackedTicketsContinued'],
  ['duplicate actual Git commit', (x) => x.git[0].commits.push('extra'), 'noDuplicateCommittedEffects'],
  ['duplicate committed file effect', (x) => { x.git[0].body += x.git[0].body; }, 'noDuplicateCommittedEffects'],
  ['duplicate external commit attempt', (x) => x.workerEvents.push({ ...x.workerEvents[0] }), 'noDuplicateCommittedEffects'],
  ['wrong committed SHA', (x) => { x.workerEvents.find((e) => e.kind === 'commit').sha = 'wrong'; }, 'noDuplicateCommittedEffects'],
  ['duplicate daemon tool commit', (x) => x.after.submission.push({ tool: 'task_transition' }), 'noDuplicateCommittedEffects'],
  ['no actual held tool continuation', (x) => { x.workerEvents = x.workerEvents.filter((e) => e.kind !== 'continued'); }, 'actualWorkContinued'],
  ['tool failure despite stored rows', (x) => { x.workerEvents.find((e) => e.kind === 'tool-result').event.isError = true; }, 'realToolResultsSucceeded'],
  ['missing Git observations', (x) => { x.git = []; }, 'noDuplicateCommittedEffects'],
  ['foreign untracked commit effect', (x) => x.workerEvents.push({ kind: 'commit', ticket: 99 }), 'noDuplicateCommittedEffects'],
  ['continuation before post-reconnect release', (x) => { x.workerEvents.find((e) => e.kind === 'continued').at = '2026-11-26T00:00:00Z'; }, 'actualWorkContinued'],
  ['continuation on a replacement after daemon restart', (x) => { x.workerEvents.find((e) => e.kind === 'continued').launch = 'new-unknown'; }, 'actualWorkContinued'],
  ['additional launch after continuation', (x) => x.after.launch.push({ launch_id: 'unexpected' }), 'noAdditionalLaunches'],
];
for (const [name, mutate, check] of negatives) {
  test(name, () => { const input = observed(); mutate(input); assert.equal(continuationChecks(input)[check], false); });
}
const relationshipNegatives = [
  ['stripped committed submission identities/results', (x) => { x.after.submission = x.after.submission.map(() => ({ tool: 'task_transition' })); }],
  ['unknown tool-result launch/call/assignment', (x) => { for (const e of x.workerEvents.filter((e) => e.event?.toolName === 'task_transition')) { e.launch = 'unknown'; e.event.toolCallId = 'unknown'; e.event.input.assignmentId = 'unknown'; } }],
  ['invalid approval assignment/transition references', (x) => { for (const a of x.after.approval) { a.assignment_id = 'unknown'; a.transition_sequence = -1; } }],
  ['wrong committed transition Git heads', (x) => { for (const t of x.after.ticket_transition) { t.git_commit = 'WRONG'; } }],
  ['wrong independently observed Git base', (x) => { for (const g of x.git) { g.base = 'WRONG'; } }],
  ['missing both downstream assignment contexts', (x) => { x.after.message = x.after.message.filter((m) => !m.id.startsWith('gm')); }],
  ['new accepted but unprocessed message', (x) => x.after.message.push({ ...x.after.message[2], id: 'new-pending', body: 'unexpected pending work', status: 'sent' })],
  ['submission launch mismatch', (x) => { x.after.submission[0].launch_id = 'unknown'; }],
  ['submission call mismatch', (x) => { x.after.submission[0].call_id = 'unknown'; }],
  ['submission slot mismatch', (x) => { x.after.submission[0].slot_id = 'dev/2'; }],
  ['submission factory mismatch', (x) => { x.after.submission[0].factory_id = 'wrong'; }],
  ['submission result assigned to another ticket', (x) => { const s = x.after.submission[0]; s.result = JSON.stringify({ ...JSON.parse(s.result), ticket: 99 }); }],
  ['unparseable submission result', (x) => { x.after.submission[0].result = 'invalid'; }],
  ['event slot mismatch', (x) => { x.workerEvents.find((e) => e.event?.toolName === 'task_transition').slot = 'wrong'; }],
  ['event input Git mismatch', (x) => { x.workerEvents.find((e) => e.event?.toolName === 'task_transition').event.input.gitCommit = 'WRONG'; }],
  ['event details result mismatch', (x) => { x.workerEvents.find((e) => e.event?.toolName === 'task_transition').event.details = { status: 'committed', value: {} }; }],
  ['event text result mismatch', (x) => { x.workerEvents.find((e) => e.event?.toolName === 'task_transition').event.content = [{ type: 'text', text: '{}' }]; }],
  ['duplicate approval IDs', (x) => { x.after.approval[1].id = x.after.approval[0].id; }],
  ['wrong approval reference in committed result', (x) => { const s = x.after.submission[2]; s.result = JSON.stringify({ ...JSON.parse(s.result), approvalId: 99 }); }],
  ['transition actor mismatch', (x) => { x.after.ticket_transition[0].actor = 'wrong'; }],
  ['recorded start commit differs from original ticket', (x) => { x.after.ticket[0].start_commit = 'WRONG'; }],
  ['gate context binding mismatch', (x) => { x.after.message.find((m) => m.id === 'gm1').bound_slot = 'dev/2'; }],
  ['gate context not acknowledged', (x) => { x.after.message.find((m) => m.id === 'gm1').status = 'sent'; }],
  ['gate context body assignment mismatch', (x) => { x.after.message.find((m) => m.id === 'gm1').body = 'Assignment: wrong'; }],
  ['unexpected extra acknowledged accepted work', (x) => x.after.message.push({ ...x.after.message[2], id: 'unexpected', body: 'unknown work' })],
];
for (const [name, mutate] of relationshipNegatives) {
  test(`relationship mutation rejected: ${name}`, () => {
    const input = observed(); mutate(input);
    const checks = { ...Object.fromEntries(requiredChecks.map((key) => [key, true])), ...continuationChecks(input) };
    assert.equal(verdict(checks, true).exitCode, 1);
  });
}
test('initially unbound acceptance may bind once, but never change an existing binding', () => {
  const input = observed(); input.before.message[3].bound_slot = null;
  assert.equal(continuationChecks(input).acceptedWorkRetained, true);
});
test('every missing/false observation and incomplete journey fails closed even when reconnect is true', () => {
  const passing = Object.fromEntries(requiredChecks.map((key) => [key, true]));
  assert.equal(verdict(passing, true).exitCode, 0);
  assert.equal(verdict(passing, false).exitCode, 1);
  for (const key of requiredChecks) {
    for (const value of [false, undefined]) {
      const result = verdict({ ...passing, [key]: value }, true);
      assert.equal(result.exitCode, 1); assert.ok(result.failed.includes(key));
    }
  }
  assert.equal(verdict({ ...passing, futureInvariant: false }, true).exitCode, 1);
});
