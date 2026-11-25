/**
 * Daemon-initiated interrupt (PRD §3.2, §5.3): abort the worker's current Pi
 * run and keep the conversation and the launch. The extension uses Pi's own
 * abort (`ctx.abort()`, the same path as Escape or RPC `abort`), never a
 * restart, new session or process signal; termination is the Worker Host's.
 *
 * The acknowledgement goes out once Pi reports the work settled, so the
 * daemon knows no tool call is still running when it acts on the ack.
 *
 * Unsupported for now: aborting a branch summary (`navigateTree` with
 * summarisation). Pi emits no settle event for it, so such an interrupt is
 * acknowledged only when some later work settles.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Interrupt, InterruptOutcome } from "@foundry/protocol";
import type { OpenChannel } from "./channel/client.js";

/** The part of Pi's extension context an interrupt needs. */
export type RunControl = Pick<ExtensionContext, "isIdle" | "abort">;

export class RunInterrupter {
  private control: RunControl | undefined;
  private waiting: Array<(aborted: boolean) => void> = [];

  /** Use `control` (from the latest `session_start`) to reach the running session. */
  bind(control: RunControl): void {
    this.control = control;
  }

  /**
   * Pi finished some work. Waiters are released only once Pi is idle, so a
   * compaction ending inside a run does not ack before the run itself settles.
   */
  settled(aborted: boolean): void {
    if (this.control && !this.control.isIdle()) {return;}

    for (const release of this.waiting.splice(0)) {release(aborted);}
  }

  /** Abort the current run, if any, and resolve once Pi is idle again. */
  async interrupt(): Promise<InterruptOutcome> {
    const control = this.control;

    if (!control || control.isIdle()) {return "idle";}

    const settled = new Promise<boolean>((resolve) => {
      this.waiting.push(resolve);
    });

    control.abort();

    // Work that completed despite the abort (a compaction past its last abort check) was not aborted.
    return (await settled) ? "aborted" : "idle";
  }

  /** Answer an `interrupt` frame on the channel it arrived on. A dead channel drops the ack. */
  handle(frame: Interrupt, channel: OpenChannel): void {
    void this.interrupt()
      .then((outcome) => channel.send({ type: "interrupt_ack", requestId: frame.requestId, outcome }))
      .catch(() => {});
  }
}

/** Feed Pi's session context and settle events into `interrupter`. */
export const interruptRuns = (pi: Pick<ExtensionAPI, "on">, interrupter: RunInterrupter): void => {
  pi.on("session_start", (_event, ctx) => interrupter.bind(ctx));
  pi.on("agent_settled", (event) => interrupter.settled(event.aborted));
  // A compaction with no run around it ends here rather than at `agent_settled`.
  // Pi emits `session_compact` before it clears its compaction state, so it is
  // still busy inside this handler: re-check once the emit has returned.
  pi.on("session_compact", () => void setImmediate(() => interrupter.settled(false)));
  pi.on("session_compact_failed", (event) => interrupter.settled(event.aborted));
};
