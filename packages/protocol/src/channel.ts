/**
 * The channel wire contract (PRD §3.2, §5.3): newline-delimited JSON frames on
 * one Unix-domain socket per instance. The first frame a worker sends is a
 * `hello` carrying the protocol version; a mismatch is rejected, not negotiated.
 */
import { Result, Schema } from "effect";

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 1 as const;

/** Timing constants (PRD §3.2). Fixed starting values, not factory configuration. */
export const HEARTBEAT_INTERVAL_MS = 5000;
export const CHANNEL_LOST_AFTER_MS = 15_000;
export const RECONNECT_BACKOFF_CAP_MS = 5000;
export const TOOL_CALL_CHANNEL_WAIT_MS = 30_000;

/** Longest frame line accepted, so a peer cannot make the other end buffer without bound. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const Id = Schema.NonEmptyString;

/** A tool the worker registered, and where it came from (checked against the Tool Set later). */
export const ReportedTool = Schema.Struct({
  name: Id,
  source: Id,
});

export type ReportedTool = typeof ReportedTool.Type;

/** The worker's opening frame. Identity claims here are unauthenticated until a slot claim accepts them. */
export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  factoryId: Id,
  slotId: Id,
  launchId: Id,
  conversationRef: Id,
  hasRecoverableHistory: Schema.Boolean,
  mode: Schema.Literals(["headless", "interactive"]),
  tools: Schema.Array(ReportedTool),
});

export type Hello = typeof Hello.Type;

/** Liveness of the channel only. A lapse means the channel is lost, never that the worker died. */
export const Heartbeat = Schema.Struct({
  type: Schema.Literal("heartbeat"),
});

export type Heartbeat = typeof Heartbeat.Type;

/**
 * The worker's conversation was compacted (PRD §5.5). Sent only on positive
 * evidence of a completed compaction; a report held while the channel was down
 * is sent once after reconnect. Several compactions while disconnected coalesce
 * into one report, because the daemon answers with a single compaction prime.
 * Delivery has no ack: a report written to the kernel is lost if the daemon
 * dies before reading it (a daemon restart leads to a recovery prime anyway).
 */
export const Compacted = Schema.Struct({
  type: Schema.Literal("compacted"),
});

export type Compacted = typeof Compacted.Type;

/**
 * Daemon-initiated control (PRD §3.2): abort the worker's current Pi run. The
 * conversation and the launch are kept; process termination never travels on
 * the channel. Not `urgent` delivery, and agents cannot send it.
 */
export const Interrupt = Schema.Struct({
  type: Schema.Literal("interrupt"),
  requestId: Id,
});

export type Interrupt = typeof Interrupt.Type;

/**
 * `aborted`: work was active (a run, or a compaction) and Pi is idle after the
 * abort. `idle`: nothing was active, or the work completed despite the abort.
 */
export const InterruptOutcome = Schema.Literals(["aborted", "idle"]);

export type InterruptOutcome = typeof InterruptOutcome.Type;

/** The worker's answer to an `interrupt`, sent once Pi is idle again. */
export const InterruptAck = Schema.Struct({
  type: Schema.Literal("interrupt_ack"),
  requestId: Id,
  outcome: InterruptOutcome,
});

export type InterruptAck = typeof InterruptAck.Type;

/**
 * Daemon-initiated control (PRD §3.2, §10.3): a graceful stop is coming. The
 * extension stops injecting held work and answers once Pi settles. Unlike
 * `interrupt`, the current run is not aborted. Termination still belongs to
 * the Worker Host and never travels on the channel.
 */
export const Drain = Schema.Struct({
  type: Schema.Literal("drain"),
  requestId: Id,
});

export type Drain = typeof Drain.Type;

/** The worker's answer to a `drain`, sent once Pi is idle. */
export const DrainAck = Schema.Struct({
  type: Schema.Literal("drain_ack"),
  requestId: Id,
});

export type DrainAck = typeof DrainAck.Type;

/** Why the daemon refused a hello. A terminal refusal stops the extension reconnecting. */
export const HelloRejectReason = Schema.Struct({
  kind: Schema.Literals(["terminal", "retryable"]),
  code: Id,
  detail: Schema.String,
});

export type HelloRejectReason = typeof HelloRejectReason.Type;

/** Refusal codes defined by the handshake itself; slot claims may add their own. */
export const RejectCode = {
  protocolVersionMismatch: "protocol_version_mismatch",
  malformedHello: "malformed_hello",
  helloRequired: "hello_required",
} as const;

export const HelloAccepted = Schema.Struct({
  type: Schema.Literal("hello_accepted"),
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
});

export type HelloAccepted = typeof HelloAccepted.Type;

export const HelloRejected = Schema.Struct({
  type: Schema.Literal("hello_rejected"),
  reason: HelloRejectReason,
});

export type HelloRejected = typeof HelloRejected.Type;

/**
 * The worker's receipt for a prime or message (PRD §5.5, §6.3): the ID is now
 * in the worker's recoverable conversation history. Arrival or injection alone
 * never earns one.
 */
export const Receipt = Schema.Struct({
  type: Schema.Literal("receipt"),
  id: Id,
});

export type Receipt = typeof Receipt.Type;

/**
 * An agent tool call (PRD §6.1): one request frame, answered by one `tool_result`. The daemon keys
 * its submission record by the launch the connection was claimed for plus Pi's tool call ID, so
 * re-sending the same call after a lost result changes nothing, while two calls with equal
 * arguments stay distinct.
 */
export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool_call"),
  callId: Id,
  tool: Id,
  args: Schema.Json,
});

export type ToolCall = typeof ToolCall.Type;

/**
 * What a tool call came to.
 * - `committed`: the submission, its effects and this stored value are in the database; a retry
 *   returns the same value.
 * - `refused`: the daemon answered and nothing of the call was committed.
 * - `not_accepted`: set by the extension, never sent by the daemon. No result arrived within the
 *   bounded wait, so the call may or may not have committed (PRD §6.1). Re-issuing it under a new
 *   call ID could repeat its effect; the worker must inspect before acting again.
 */
export const ToolCallOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("committed"), value: Schema.Json }),
  Schema.Struct({ status: Schema.Literal("refused"), code: Id, detail: Schema.String }),
  Schema.Struct({ status: Schema.Literal("not_accepted"), detail: Schema.String }),
]);

export type ToolCallOutcome = typeof ToolCallOutcome.Type;

/** Why a tool call was refused. */
export const ToolRefusalCode = {
  /** The worker's slot is frozen (PRD §5.3); the daemon refuses its calls. */
  slotFrozen: "slot_frozen",
  /** The daemon serves no tool by that name. */
  unknownTool: "unknown_tool",
  /** The daemon tried and rolled back: nothing from the call was kept. */
  notCommitted: "not_committed",
} as const;

/** The daemon's answer to a `tool_call`, sent only after the commit. */
export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  callId: Id,
  outcome: ToolCallOutcome,
});

export type ToolResult = typeof ToolResult.Type;

/** Frames a worker sends after its hello is accepted. */
export const WorkerFrame = Schema.Union([Heartbeat, Compacted, Receipt, InterruptAck, DrainAck, ToolCall]);

export type WorkerFrame = typeof WorkerFrame.Type;

/**
 * A prime (PRD §5.5): the only path priming text takes to a worker. It is
 * injected into the conversation as a message and never starts a turn.
 */
export const Prime = Schema.Struct({
  type: Schema.Literal("prime"),
  id: Id,
  text: Schema.String,
});

export type Prime = typeof Prime.Type;

/** Frames the daemon sends on an accepted connection, after `hello_accepted`. */
export const DaemonFrame = Schema.Union([Prime, Interrupt, Drain, ToolResult]);

export type DaemonFrame = typeof DaemonFrame.Type;

/** Frames the daemon sends in reply to a hello. */
export const HelloReply = Schema.Union([HelloAccepted, HelloRejected]);

export type HelloReply = typeof HelloReply.Type;

export type Decoded<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: HelloRejectReason };

const terminal = (code: string, detail: string): HelloRejectReason => ({ kind: "terminal", code, detail });

/** `JSON.parse` throws a `SyntaxError`, whose message is what a rejection shows. */
const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));

const parseJson = (line: string): { ok: true; value: unknown } | { ok: false; detail: string } => {
  try {
    const value: unknown = JSON.parse(line);

    return { ok: true, value };
  } catch (error) {
    return { ok: false, detail: `not JSON: ${hasMessage(error) ? error.message : String(error)}` };
  }
};

/**
 * Just enough of a hello to tell "not a hello" from "a hello of another version". The version is
 * read as given, so a missing one is reported as a mismatch.
 */
const isHelloHeader = Schema.is(
  Schema.Struct({ type: Schema.Literal("hello"), protocolVersion: Schema.optionalKey(Schema.Unknown) }),
);

const decodeHelloSchema = Schema.decodeUnknownResult(Hello);

/**
 * Decode the first line on a connection as a hello. A version mismatch is
 * reported distinctly from any other malformation; both are terminal.
 */
export const decodeHelloLine = (line: string): Decoded<Hello> => {
  const json = parseJson(line);

  if (!json.ok) {return { ok: false, reason: terminal(RejectCode.malformedHello, json.detail) };}

  const value = json.value;

  if (!isHelloHeader(value)) {
    return { ok: false, reason: terminal(RejectCode.helloRequired, "the first frame must be a hello") };
  }

  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: terminal(
        RejectCode.protocolVersionMismatch,
        `expected protocol version ${PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`,
      ),
    };
  }

  const decoded = decodeHelloSchema(value);

  if (Result.isFailure(decoded)) {
    return { ok: false, reason: terminal(RejectCode.malformedHello, String(decoded.failure)) };
  }

  return { ok: true, value: decoded.success };
};

const decodeLine = <S extends Schema.ConstraintDecoder<unknown>>(line: string, schema: S) => {
  const json = parseJson(line);

  if (!json.ok) {return { ok: false as const, detail: json.detail };}

  const decoded = Schema.decodeUnknownResult(schema)(json.value);

  return Result.isFailure(decoded)
    ? { ok: false as const, detail: String(decoded.failure) }
    : { ok: true as const, value: decoded.success };
};

/** Decode a post-hello frame from a worker. */
export const decodeWorkerFrameLine = (line: string) => decodeLine(line, WorkerFrame);

/** Decode the daemon's reply to a hello. */
export const decodeHelloReplyLine = (line: string) => decodeLine(line, HelloReply);

/** Decode a post-hello frame from the daemon. */
export const decodeDaemonFrameLine = (line: string) => decodeLine(line, DaemonFrame);

/** Serialize one frame as a newline-terminated JSON line. */
export const encodeFrame = (frame: Hello | WorkerFrame | HelloReply | DaemonFrame): string => `${JSON.stringify(frame)}\n`;

/**
 * Split a byte stream into frame lines. Throws once a pending line exceeds
 * `maxBytes`, so the caller can drop the connection instead of buffering.
 */
export class FrameLineSplitter {
  private pending = "";
  constructor(private readonly maxBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: string): Array<string> {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";

    for (const line of [...parts, this.pending]) {
      if (Buffer.byteLength(line) > this.maxBytes) {throw new Error(`frame exceeds ${this.maxBytes} bytes`);}
    }

    return parts.filter((line) => line.trim().length > 0);
  }
}
