// Plain evidence policy, not runtime recovery logic. Every required observation fails closed.
export const requiredChecks = [
  "privateTempPropagated", "workerReplacementAccepted", "acceptedMessageStoredAndBound",
  "survivingWorkersReconnected", "channelTrafficResumed", "ticketArtifactsUnchanged",
  "liveLaunchesPreserved", "acceptedRowsAndBindingPreserved", "assignmentsPreserved",
  "cleanup", "cleanupPhasesSucceeded",
];

export function boundedVerdict(checks, journeyCompleted) {
  const applicable = [...new Set([...requiredChecks, ...Object.keys(checks)])];
  const failedInvariants = applicable.filter((key) => checks[key] !== true);
  const reconnectOnly = failedInvariants.length > 0 && failedInvariants.every((key) =>
    key === "survivingWorkersReconnected" || key === "channelTrafficResumed");
  return {
    outcome: failedInvariants.length === 0 && journeyCompleted ? "bounded-pass-not-ticket-acceptance"
      : !journeyCompleted ? "blocked-first-failure" : reconnectOnly ? "blocked-reconnect" : "blocked-invariant",
    failedInvariants,
    exitCode: failedInvariants.length === 0 && journeyCompleted ? 0 : 1,
    fullTicketAcceptance: false,
  };
}

// A stop/copy/removal failure must not prevent later cleanup phases or final-manifest publication.
export async function guardedPhases(phases, onError) {
  const errors = [];
  for (const [phase, action] of phases) {
    try {await action();}
    catch (error) {
      const failure = { phase, error: String(error.stack ?? error) };
      errors.push(failure);
      onError(failure);
    }
  }
  return errors;
}
