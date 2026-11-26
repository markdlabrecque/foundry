// Pure observation oracle. Input is independently captured Git/log/store evidence, not booleans
// supplied by the worker. Successful continuation is stronger than a reconnected socket.
export function sameUid(status, uid) {
  return Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) === uid;
}
export function continuationChecks({ before, after, workerEvents, git, artifactsBefore, artifactsAfter, releasedAt, liveLaunchIds }) {
  const initial = before.assignment.filter((a) => a.stage === 'implement');
  const numbers = initial.map((a) => a.ticket_number);
  const shape = numbers.length === 2 && new Set(numbers).size === 2 && after.ticket.length === 2 && git.length === 2 && artifactsBefore.length === 2 && artifactsAfter.length === 2;
  const each = (fn) => shape && initial.every(fn);
  const relevant = (a, kind) => workerEvents.filter((e) => e.kind === kind && e.ticket === a.ticket_number);
  return {
    acceptedWorkRetained: before.message.length >= 4 && new Set(after.message.map((m) => m.id)).size === after.message.length && before.message.every((m) =>
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
    trackedTicketsContinued: each((a) => {
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
      return observation && observation.commits.length === 1 && observation.head === observation.commits[0] && observation.head !== observation.base &&
        observation.body === `COMMITTED_EFFECT ticket=${a.ticket_number} assignment=${a.id}\n` && attempts.length === 1 && commits.length === 1 && commits[0].assignmentId === a.id && commits[0].sha === observation.head;
    }) && after.submission.filter((s) => s.tool === 'task_transition').length === 4,
    actualWorkContinued: Number.isFinite(Date.parse(releasedAt)) && liveLaunchIds.length === 2 && workerEvents.filter((e) => e.kind === 'continued').length === 2 && each((a) => {
      const rows = relevant(a, 'continued');
      const observation = git.find((g) => g.number === a.ticket_number);
      return rows.length === 1 && rows[0].assignmentId === a.id && rows[0].sha === observation?.head && Date.parse(rows[0].at) >= Date.parse(releasedAt) && liveLaunchIds.includes(rows[0].launch);
    }),
    realToolResultsSucceeded: workerEvents.filter((e) => e.kind === 'tool-result' && e.event.toolName === 'task_transition').length === 4 &&
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
