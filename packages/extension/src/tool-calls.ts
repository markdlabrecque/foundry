/**
 * The extension's half of agent tool calls (PRD §6.1). A call is one `tool_call` frame keyed by
 * Pi's tool call ID, answered by one `tool_result` the daemon sends only after its commit, so a
 * call never reports success before the daemon has committed it.
 *
 * While no channel is attached, a call waits up to a bounded time for one, then settles with an
 * explicit `not_accepted` refusal. A call whose channel ends before its result arrives is re-sent
 * on the next attached channel with the same call ID; the daemon returns the stored result of a
 * call it already committed and changes nothing.
 */
import { TOOL_CALL_CHANNEL_WAIT_MS, ToolRefusalCode } from "@foundry/protocol";
import type { Schema } from "effect";
import type { ToolCallOutcome, ToolResult } from "@foundry/protocol";
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
  private readonly waitMs: number;
  private readonly timer: ChannelWaitTimer;

  constructor(options: ToolCallClientOptions = {}) {
    this.waitMs = options.channelWaitMs ?? TOOL_CALL_CHANNEL_WAIT_MS;
    this.timer = options.timer ?? realTimer;
  }

  /**
   * Submit one call. Resolves with the daemon's outcome, or a `not_accepted` refusal if no channel
   * carried the call and its result within the bounded wait. A second call with the same ID while
   * the first is pending shares its outcome rather than sending twice.
   */
  call(callId: string, tool: string, args: Schema.Json): Promise<ToolCallOutcome> {
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

  /** Use `channel` for calls until it closes, re-sending every call still waiting for a result. */
  attach(channel: OpenChannel): void {
    this.channel = channel;
    void channel.closed.then(() => this.detach(channel));

    for (const entry of this.pending.values()) {this.dispatch(entry);}
  }

  /** Pass every `tool_result` frame from the daemon here. A result for no pending call is ignored. */
  receive(frame: ToolResult): void {
    const entry = this.pending.get(frame.callId);

    if (entry === undefined) {return;}

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
          status: "refused",
          code: ToolRefusalCode.notAccepted,
          detail: `no channel to the daemon within ${this.waitMs} ms; the call may or may not have been committed`,
        });
      });

      return;
    }

    entry.cancelWait?.();
    entry.cancelWait = undefined;
    entry.sentOn = channel;
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
