// Pure observation oracle. Input is independently captured Git/log/store evidence, not booleans
// supplied by the worker. Successful continuation is stronger than a reconnected socket.
import { isDeepStrictEqual } from 'node:util';

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}
const field = (body, name) => new RegExp(`^${name}: (.+)$`, 'm').exec(body ?? '')?.[1];

export function sameUid(status, uid) {
  return Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) === uid;
}
export function continuationChecks({ before, after, workerEvents, git, artifactsBefore, artifactsAfter, releasedAt, liveLaunchIds }) {
  const initial = before.assignment.filter((a) => a.stage === 'implement');
  const numbers = initial.map((a) => a.ticket_number);
  const shape = numbers.length === 2 && new Set(numbers).size === 2 && after.ticket.length === 2 && git.length === 2 && artifactsBefore.length === 2 && artifactsAfter.length === 2;
  const each = (fn) => shape && initial.every(fn);
  const relevant = (a, kind) => workerEvents.filter((e) => e.kind === kind && e.ticket === a.ticket_number);
  const tools = workerEvents.filter((e) => e.kind === 'tool-result' && e.event?.toolName === 'task_transition');
  const outcomesMatch = shape && after.assignment.length === 4 && new Set(after.assignment.map((a) => a.id)).size === 4 &&
    after.submission.length === 4 && tools.length === 4 && after.approval.length === 2 && after.approval.every((r) => Number.isInteger(r.id) && r.id > 0) && new Set(after.approval.map((r) => r.id)).size === 2 &&
    after.ticket_transition.filter((t) => t.outcome === 'done').length === 4 && new Set(after.ticket_transition.filter((t) => t.outcome === 'done').map((t) => t.sequence)).size === 4 &&
    new Set(after.submission.map((s) => `${s.launch_id}/${s.call_id}`)).size === 4 &&
    new Set(tools.map((e) => `${e.launch}/${e.event.toolCallId}`)).size === 4 && after.assignment.every((a) => {
      const observation = git.find((g) => g.number === a.ticket_number);
      const transitions = after.ticket_transition.filter((t) => t.factory_id === a.factory_id && t.ticket_number === a.ticket_number && t.from_stage === a.stage && t.outcome === 'done');
      const events = tools.filter((e) => e.event.input?.assignmentId === a.id);
      if (!observation || transitions.length !== 1 || events.length !== 1) { return false; }
      const transition = transitions[0]; const e = events[0];
      const launch = after.launch.find((l) => l.launch_id === e.launch);
      const submissions = after.submission.filter((s) => s.launch_id === e.launch && s.call_id === e.event.toolCallId);
      const approvals = after.approval.filter((r) => r.factory_id === a.factory_id && r.ticket_number === a.ticket_number && r.assignment_id === a.id && r.transition_sequence === transition.sequence && r.kind === 'stage_gate' && r.state === 'open');
      if (!['implement', 'gate'].includes(a.stage) || (a.stage === 'gate' ? approvals.length !== 1 : approvals.length !== 0) || submissions.length !== 1) { return false; }
      const expected = { assignmentId: a.id, ticket: a.ticket_number, stage: 'gate', status: a.stage === 'gate' ? 'awaiting_approval' : 'queued', ...(a.stage === 'gate' ? { approvalId: approvals[0].id } : {}) };
      const submission = submissions[0];
      return typeof a.factory_id === 'string' && typeof e.event.toolCallId === 'string' && liveLaunchIds.includes(e.launch) &&
        launch?.factory_id === a.factory_id && launch.slot_id === a.slot_id && e.slot === a.slot_id &&
        submission.factory_id === a.factory_id && submission.slot_id === a.slot_id && submission.tool === 'task_transition' &&
        e.event.isError === false && e.event.input.outcome === 'done' && e.event.input.gitCommit === observation.head &&
        transition.actor === a.slot_id && transition.git_commit === observation.head && transition.to_state === 'stage' && transition.to_stage === expected.stage && transition.to_status === expected.status &&
        isDeepStrictEqual(json(submission.result), expected) && e.event.details?.status === 'committed' && isDeepStrictEqual(e.event.details.value, expected) &&
        e.event.content?.length === 1 && isDeepStrictEqual(json(e.event.content[0].text), expected);
    });
  const contextsMatch = shape && after.assignment.length === 4 && after.assignment.every((a) => {
    const messages = after.message.filter((m) => m.id === a.context_message);
    const m = messages[0];
    return messages.length === 1 && m.factory_id === a.factory_id && m.ticket_number === a.ticket_number &&
      m.bound_slot === a.slot_id && m.recipient === 'eng.dev' && m.status === 'acknowledged' &&
      field(m.body, 'Assignment') === a.id && field(m.body, 'Stage') === a.stage && field(m.body, 'Slot') === a.slot_id &&
      new RegExp(`^Ticket ${a.ticket_number}(?::|$)`, 'm').test(m.body);
  });
  const expectedMessages = new Set([...before.message.map((m) => m.id), ...after.assignment.map((a) => a.context_message)]);
  return {
    acceptedWorkRetained: contextsMatch && after.message.length === expectedMessages.size && after.message.every((m) => expectedMessages.has(m.id) && m.status === 'acknowledged' && m.bound_slot != null) && before.message.length >= 4 && new Set(after.message.map((m) => m.id)).size === after.message.length && before.message.every((m) =>
      after.message.some((n) => n.id === m.id && n.body === m.body && n.recipient === m.recipient && n.bound_slot !== null && (m.bound_slot === null || n.bound_slot === m.bound_slot) && n.status === 'acknowledged')),
    ordinaryMessagesProcessed: ['FOU124_BEFORE_WORKER', 'FOU124_BEFORE_DAEMON'].every((body) => {
      const rows = after.message.filter((m) => m.body === body);
      return rows.length === 1 && rows[0].bound_slot !== null && rows[0].status === 'acknowledged' && workerEvents.some((e) => e.kind === 'incoming' && e.text?.includes(body));
    }),
    artifactBindingsUnchanged: each((a) => {
      const b = artifactsBefore.find((x) => x.number === a.ticket_number);
      const c = artifactsAfter.find((x) => x.number === a.ticket_number);
      return b && c && JSON.stringify(b) === JSON.stringify(c);
    }),
    originalAssignmentsHonored: each((a) => after.assignment.some((b) => b.id === a.id && b.ticket_number === a.ticket_number && b.stage === a.stage && b.slot_id === a.slot_id && b.context_message === a.context_message && b.status === 'ended' && b.end_reason === 'done')),
    trackedTicketsContinued: outcomesMatch && each((a) => {
      const ticket = after.ticket.find((t) => t.number === a.ticket_number);
      const assignments = after.assignment.filter((b) => b.ticket_number === a.ticket_number);
      const transitions = after.ticket_transition.filter((t) => t.ticket_number === a.ticket_number && t.outcome === 'done');
      return ticket?.state === 'stage' && ticket.stage === 'gate' && ticket.status === 'awaiting_approval' && assignments.length === 2 && assignments.every((b) => b.status === 'ended' && b.end_reason === 'done') &&
        transitions.length === 2 && ['implement', 'gate'].every((stage) => transitions.filter((t) => t.from_stage === stage).length === 1) &&
        after.approval.filter((r) => r.ticket_number === a.ticket_number && r.kind === 'stage_gate' && r.state === 'open').length === 1;
    }),
    noAdditionalLaunches: before.launch.length === 3 && after.launch.length === 3 && new Set(after.launch.map((l) => l.launch_id)).size === 3 && before.launch.every((l) => after.launch.some((n) => n.launch_id === l.launch_id)),
    noDuplicateCommittedEffects: workerEvents.filter((e) => e.kind === 'commit-attempt').length === 2 && workerEvents.filter((e) => e.kind === 'commit').length === 2 && each((a) => {
      const observation = git.find((g) => g.number === a.ticket_number);
      const commits = relevant(a, 'commit');
      const attempts = relevant(a, 'commit-attempt');
      const originalTicket = before.ticket.find((t) => t.number === a.ticket_number && t.factory_id === a.factory_id);
      const finalTicket = after.ticket.find((t) => t.number === a.ticket_number && t.factory_id === a.factory_id);
      const prepared = artifactsBefore.find((t) => t.number === a.ticket_number);
      return observation && typeof observation.base === 'string' && observation.base === originalTicket?.start_commit && observation.base === finalTicket?.start_commit && observation.base === prepared?.worktree.startCommit && observation.head === prepared?.head && observation.commits.length === 1 && observation.head === observation.commits[0] && observation.head !== observation.base &&
        observation.body === `COMMITTED_EFFECT ticket=${a.ticket_number} assignment=${a.id}\n` && attempts.length === 1 && commits.length === 1 && commits[0].assignmentId === a.id && commits[0].sha === observation.head;
    }) && outcomesMatch,
    actualWorkContinued: Number.isFinite(Date.parse(releasedAt)) && liveLaunchIds.length === 2 && workerEvents.filter((e) => e.kind === 'continued').length === 2 && each((a) => {
      const rows = relevant(a, 'continued');
      const observation = git.find((g) => g.number === a.ticket_number);
      return rows.length === 1 && rows[0].assignmentId === a.id && rows[0].sha === observation?.head && Date.parse(rows[0].at) >= Date.parse(releasedAt) && liveLaunchIds.includes(rows[0].launch);
    }),
    realToolResultsSucceeded: outcomesMatch &&
      workerEvents.filter((e) => e.kind === 'tool-result').every((e) => e.event.isError !== true),
  };
}
export const requiredChecks = [
  'freshProtocol5Host', 'privateTempPropagated', 'originalWorkActive', 'workerReplacementRecovered',
  'sameHostAndSurvivingLaunches', 'survivingWorkersReconnected', 'channelTrafficResumed',
  'noDaemonRestartWorkReplay', 'acceptedWorkRetained', 'ordinaryMessagesProcessed',
  'artifactBindingsUnchanged', 'originalAssignmentsHonored', 'trackedTicketsContinued',
  'noAdditionalLaunches', 'noDuplicateCommittedEffects', 'actualWorkContinued', 'realToolResultsSucceeded',
  'orderlyCleanup', 'cleanup', 'cleanupPhasesSucceeded',
];
export function verdict(checks, journeyCompleted) {
  const failed = [...new Set([...requiredChecks, ...Object.keys(checks)])].filter((key) => checks[key] !== true);
  return { result: journeyCompleted && failed.length === 0 ? 'supported-disposable-combined-crash-journey' : 'unmet-or-unverified', failed, exitCode: journeyCompleted && failed.length === 0 ? 0 : 1 };
}
