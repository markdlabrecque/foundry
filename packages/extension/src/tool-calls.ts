/**
 * The extension's half of agent tool calls (PRD §6.1). A call is one `tool_call` frame keyed by
 * Pi's tool call ID, answered by one `tool_result` the daemon sends only after its commit, so a
 * call never reports success before the daemon has committed it.
 *
 * While no channel is attached, a call waits up to a bounded time for one, then settles as
 * `not_accepted`: the call may or may not have committed, which is never reported as a refusal. A
 * call whose channel ends before its result arrives is re-sent
 * on the next attached channel with the same call ID; the daemon returns the stored result of a
 * call it already committed and changes nothing. A terminal hello refusal ends these waits and
 * prevents further dispatch for this launch. Never-dispatched calls report the explicit refusal;
 * an unanswered prior dispatch keeps its commit uncertainty with that reason in the detail.
 */
import { TOOL_CALL_CHANNEL_WAIT_MS } from "@foundry/protocol";
import type { Schema } from "effect";
import type { HelloRejectReason, ToolCallOutcome, ToolResult } from "@foundry/protocol";
import type { OpenChannel } from "./channel/client.js";

/** Schedules the channel wait; injectable so tests need no wall-clock waits. Returns a canceller. */
export type ChannelWaitTimer = (ms: number, onExpired: () => void) => () => void;

const realTimer: ChannelWaitTimer = (ms, onExpired) => {
  const handle = setTimeout(onExpired, ms);

  return () => clearTimeout(handle);
};

export interface ToolCallClientOptions {
  /** Defaults to `TOOL_CALL_CHANNEL_WAIT_MS`. */
  readonly channelWaitMs?: number;
  readonly timer?: ChannelWaitTimer;
}

interface PendingCall {
  readonly callId: string;
  readonly tool: string;
  readonly args: Schema.Json;
  /** Everyone waiting on this call ID's outcome. */
  readonly waiters: Array<(outcome: ToolCallOutcome) => void>;
  /** The channel the call was last written to, if it is still waiting on that one. */
  sentOn: OpenChannel | undefined;
  /** Cancels the channel wait, while one runs. */
  cancelWait: (() => void) | undefined;
}

export class ToolCallClient {
  private readonly pending = new Map<string, PendingCall>();
  private channel: OpenChannel | undefined;
  private terminalReason: HelloRejectReason | undefined;
  /** Dispatches without a daemon outcome, retained even after a disconnected wait expires. */
  private readonly uncertainCallIds = new Set<string>();
  private readonly waitMs: number;
  private readonly timer: ChannelWaitTimer;

  constructor(options: ToolCallClientOptions = {}) {
    this.waitMs = options.channelWaitMs ?? TOOL_CALL_CHANNEL_WAIT_MS;
    this.timer = options.timer ?? realTimer;
  }

  /**
   * Submit one call. Resolves with the daemon's outcome, or `not_accepted` if no channel carried
   * the call and its result within the bounded wait. A terminal hello refusal settles immediately.
   *
   * Once written to a live channel, a call waits for its result without a bound: PRD §3.2 bounds
   * only the wait for a channel, and a lost channel is detected by its heartbeat lapse, after which
   * the bounded wait applies again. A second call with the same ID while
   * the first is pending shares its outcome rather than sending twice.
   */
  call(callId: string, tool: string, args: Schema.Json): Promise<ToolCallOutcome> {
    if (this.terminalReason !== undefined) {
      return Promise.resolve(this.terminalOutcome(this.terminalReason, this.uncertainCallIds.has(callId)));
    }

    const existing = this.pending.get(callId);

    if (existing !== undefined) {
      return new Promise((resolve) => {
        existing.waiters.push(resolve);
      });
    }

    return new Promise((resolve) => {
      const entry: PendingCall = { callId, tool, args, waiters: [resolve], sentOn: undefined, cancelWait: undefined };
      this.pending.set(callId, entry);
      this.dispatch(entry);
    });
  }

  /** Terminal hello refusals last for this launch; retryable refusals leave channel waits alone. */
  refuse(reason: HelloRejectReason): void {
    if (reason.kind !== "terminal" || this.terminalReason !== undefined) {return;}

    this.terminalReason = reason;
    this.channel = undefined;

    for (const entry of this.pending.values()) {
      this.finish(entry, this.terminalOutcome(reason, this.uncertainCallIds.has(entry.callId)));
    }
  }

  /** Whether this launch must never dial or dispatch again. */
  get terminallyRefused(): boolean {
    return this.terminalReason !== undefined;
  }

  private terminalOutcome(reason: HelloRejectReason, wasDispatched: boolean): ToolCallOutcome {
    // A hello refusal says nothing about an earlier connection's commit. Preserve uncertainty.
    if (wasDispatched) {
      return {
        status: "not_accepted",
        detail: `${reason.code}: ${reason.detail}; the call may or may not have been committed`,
      };
    }

    return { status: "refused", code: reason.code, detail: reason.detail };
  }

  /** Use `channel` for calls until it closes, re-sending every call still waiting for a result. */
  attach(channel: OpenChannel): void {
    if (this.terminallyRefused) {return;}

    this.channel = channel;
    void channel.closed.then(() => this.detach(channel));

    for (const entry of this.pending.values()) {this.dispatch(entry);}
  }

  /** Pass every `tool_result` frame from the daemon here. A result for no pending call is ignored. */
  receive(frame: ToolResult): void {
    const entry = this.pending.get(frame.callId);

    if (entry === undefined) {return;}

    this.uncertainCallIds.delete(frame.callId);
    this.finish(entry, frame.outcome);
  }

  /** Calls submitted but not yet answered. */
  pendingCallIds(): ReadonlyArray<string> {
    return [...this.pending.keys()];
  }

  private detach(channel: OpenChannel): void {
    if (this.channel === channel) {this.channel = undefined;}

    // Calls written to the lost channel wait for the next one; their results may have been lost.
    for (const entry of this.pending.values()) {
      if (entry.sentOn === channel) {
        entry.sentOn = undefined;
        this.dispatch(entry);
      }
    }
  }

  private dispatch(entry: PendingCall): void {
    const channel = this.channel;

    if (entry.sentOn !== undefined && entry.sentOn === channel) {return;}

    if (channel === undefined) {
      entry.cancelWait ??= this.timer(this.waitMs, () => {
        entry.cancelWait = undefined;
        this.finish(entry, {
          status: "not_accepted",
          detail: `no channel to the daemon within ${this.waitMs} ms; the call may or may not have been committed`,
        });
      });

      return;
    }

    entry.cancelWait?.();
    entry.cancelWait = undefined;
    entry.sentOn = channel;
    this.uncertainCallIds.add(entry.callId);
    channel.send({ type: "tool_call", callId: entry.callId, tool: entry.tool, args: entry.args }).catch(() => {
      // The write failed: the channel is going away. Wait for the next one, within the bound.
      if (this.channel === channel) {this.channel = undefined;}

      if (entry.sentOn === channel && this.pending.get(entry.callId) === entry) {
        entry.sentOn = undefined;
        this.dispatch(entry);
      }
    });
  }

  private finish(entry: PendingCall, outcome: ToolCallOutcome): void {
    if (this.pending.get(entry.callId) !== entry) {return;}

    this.pending.delete(entry.callId);
    entry.cancelWait?.();
    entry.cancelWait = undefined;

    for (const resolve of entry.waiters.splice(0)) {resolve(outcome);}
  }
}
