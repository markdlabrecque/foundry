/**
 * Bounded termination of one owned process group: SIGTERM, a grace period,
 * then SIGKILL and a bounded wait. Success is claimed only on positive
 * evidence that the group is gone, never because a deadline passed.
 */

export type GroupSignal = "SIGTERM" | "SIGKILL" | 0;

export interface TerminateGroupDeps {
  /**
   * Sends `signal` (0 only probes) to every process in group `pgid`. Returns
   * false when the group has no process left (ESRCH), true otherwise.
   */
  readonly signalGroup: (pgid: number, signal: GroupSignal) => boolean;
  /** True once the host, as parent, has reaped the group leader. */
  readonly leaderReaped: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TerminateGroupOptions {
  /** Time between SIGTERM and SIGKILL. 0 skips SIGTERM and kills at once. */
  readonly graceMs: number;
  /** How long to wait for the group to vanish after SIGKILL. */
  readonly killWaitMs: number;
  readonly pollMs?: number;
}

export interface GroupTermination {
  /** `gone`: the leader is reaped and no process is left in the group. */
  readonly outcome: "gone" | "unconfirmed";
  /** Whether SIGKILL was sent. */
  readonly escalated: boolean;
}

export async function terminateGroup(
  pgid: number,
  options: TerminateGroupOptions,
  deps: TerminateGroupDeps,
): Promise<GroupTermination> {
  const sleep = deps.sleep ?? ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  const pollMs = options.pollMs ?? 20;
  // While the leader is unreaped it holds the pgid, so the group cannot be a
  // reused one; once it is reaped, an empty group is never signalled again.
  const gone = (): boolean => deps.leaderReaped() && !deps.signalGroup(pgid, 0);

  const waitUntilGone = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;

    for (;;) {
      if (gone()) {return true;}

      if (Date.now() >= deadline) {return false;}

      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  };

  if (gone()) {return { outcome: "gone", escalated: false };}

  if (options.graceMs > 0) {
    deps.signalGroup(pgid, "SIGTERM");

    if (await waitUntilGone(options.graceMs)) {return { outcome: "gone", escalated: false };}
  }

  deps.signalGroup(pgid, "SIGKILL");

  return { outcome: (await waitUntilGone(options.killWaitMs)) ? "gone" : "unconfirmed", escalated: true };
}
