/** PRD §6.3: absence alone never authorizes another consumable copy. */
export interface RetryEvidence {
  readonly status: "history" | "pending" | "absent";
  /** Same authenticated launch, confirmed replacement, or unproven ownership/death. */
  readonly launch: "same" | "replacement" | "unknown";
  readonly lifecycle: "idle" | "working" | "unknown";
}

export type RetryDecision = "acknowledge" | "leave_pending" | "retry" | "recheck_when_idle" | "indeterminate";

export const decideMessageRetry = (evidence: RetryEvidence): RetryDecision => {
  if (evidence.status === "history") {return "acknowledge";}

  if (evidence.status === "pending") {return "leave_pending";}

  if (evidence.launch === "replacement") {return "retry";}

  if (evidence.launch === "same" && evidence.lifecycle === "idle") {return "retry";}

  if (evidence.launch === "same" && evidence.lifecycle === "working") {return "recheck_when_idle";}

  return "indeterminate";
};
