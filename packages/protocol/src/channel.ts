/**
 * The channel wire contract (PRD §3.2, §5.3): newline-delimited JSON frames on
 * one Unix-domain socket per instance. The first frame a worker sends is a
 * `hello` carrying the protocol version; a mismatch is rejected, not negotiated.
 */
import { Result, Schema } from "effect";

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 1 as const;

/** Timing constants (PRD §3.2). Fixed starting values, not factory configuration. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const CHANNEL_LOST_AFTER_MS = 15_000;
export const RECONNECT_BACKOFF_CAP_MS = 5_000;
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
 */
export const Compacted = Schema.Struct({
  type: Schema.Literal("compacted"),
});
export type Compacted = typeof Compacted.Type;

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

/** Frames a worker sends after its hello is accepted. */
export const WorkerFrame = Schema.Union([Heartbeat, Compacted]);
export type WorkerFrame = typeof WorkerFrame.Type;

/** Frames the daemon sends in reply to a hello. */
export const HelloReply = Schema.Union([HelloAccepted, HelloRejected]);
export type HelloReply = typeof HelloReply.Type;

export type Decoded<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: HelloRejectReason };

const terminal = (code: string, detail: string): HelloRejectReason => ({ kind: "terminal", code, detail });

const parseJson = (line: string): { ok: true; value: unknown } | { ok: false; detail: string } => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (error) {
    return { ok: false, detail: `not JSON: ${(error as Error).message}` };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeHelloSchema = Schema.decodeUnknownResult(Hello);

/**
 * Decode the first line on a connection as a hello. A version mismatch is
 * reported distinctly from any other malformation; both are terminal.
 */
export const decodeHelloLine = (line: string): Decoded<Hello> => {
  const json = parseJson(line);
  if (!json.ok) return { ok: false, reason: terminal(RejectCode.malformedHello, json.detail) };
  const value = json.value;
  if (!isRecord(value) || value["type"] !== "hello") {
    return { ok: false, reason: terminal(RejectCode.helloRequired, "the first frame must be a hello") };
  }
  if (value["protocolVersion"] !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: terminal(
        RejectCode.protocolVersionMismatch,
        `expected protocol version ${PROTOCOL_VERSION}, got ${JSON.stringify(value["protocolVersion"])}`,
      ),
    };
  }
  const decoded = decodeHelloSchema(value);
  if (Result.isFailure(decoded)) {
    return { ok: false, reason: terminal(RejectCode.malformedHello, String(decoded.failure)) };
  }
  return { ok: true, value: decoded.success };
};

const decodeWorkerFrameSchema = Schema.decodeUnknownResult(WorkerFrame);
const decodeHelloReplySchema = Schema.decodeUnknownResult(HelloReply);

const decodeLine = <A>(line: string, decode: (u: unknown) => Result.Result<A, Schema.SchemaError>) => {
  const json = parseJson(line);
  if (!json.ok) return { ok: false as const, detail: json.detail };
  const decoded = decode(json.value);
  return Result.isFailure(decoded)
    ? { ok: false as const, detail: String(decoded.failure) }
    : { ok: true as const, value: decoded.success };
};

/** Decode a post-hello frame from a worker. */
export const decodeWorkerFrameLine = (line: string) => decodeLine(line, decodeWorkerFrameSchema);

/** Decode the daemon's reply to a hello. */
export const decodeHelloReplyLine = (line: string) => decodeLine(line, decodeHelloReplySchema);

/** Serialize one frame as a newline-terminated JSON line. */
export const encodeFrame = (frame: Hello | WorkerFrame | HelloReply): string => `${JSON.stringify(frame)}\n`;

/**
 * Split a byte stream into frame lines. Throws once a pending line exceeds
 * `maxBytes`, so the caller can drop the connection instead of buffering.
 */
export class FrameLineSplitter {
  private pending = "";
  constructor(private readonly maxBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const line of [...parts, this.pending]) {
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error(`frame exceeds ${this.maxBytes} bytes`);
    }
    return parts.filter((line) => line.trim().length > 0);
  }
}
