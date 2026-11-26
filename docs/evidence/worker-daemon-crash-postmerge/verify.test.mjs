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
    submission: [1, 2, 3, 4].map(() => ({ tool: 'task_transition' })),
  };
  const workerEvents = [1, 2].flatMap((ticket) => ['commit-attempt', 'commit', 'continued'].map((kind) => ({ kind, ticket, assignmentId: `a${ticket}`, sha: `sha${ticket}`, at: '2026-11-26T00:00:02Z', launch: ticket === 1 ? 'replacement' : 'survivor' })));
  workerEvents.push(...before.message.slice(2).map((m) => ({ kind: 'incoming', text: m.body })), ...[1, 2, 3, 4].map(() => ({ kind: 'tool-result', event: { toolName: 'task_transition', isError: false } })));
  const git = [1, 2].map((number) => ({ number, base: 'base', head: `sha${number}`, commits: [`sha${number}`], body: `COMMITTED_EFFECT ticket=${number} assignment=a${number}\n` }));
  const artifactsBefore = [1, 2].map((number) => ({ number, specHash: `spec${number}`, worktree: `path${number}`, head: `sha${number}` }));
  return { before, after, workerEvents, git, artifactsBefore, artifactsAfter: structuredClone(artifactsBefore), releasedAt: '2026-11-26T00:00:01Z', liveLaunchIds: ['survivor', 'replacement'] };
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
