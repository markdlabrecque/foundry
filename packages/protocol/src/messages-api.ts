/** Operator sends share the daemon's durable message log (PRD §11.4). */
import { Schema } from "effect";

export const MESSAGES_PATH = "/api/v1/messages";

export const SendMessageRequest = Schema.Struct({
  factory: Schema.optionalKey(Schema.NonEmptyString),
  recipient: Schema.NonEmptyString,
  body: Schema.String,
  delivery: Schema.optionalKey(Schema.Literals(["after_turn", "when_idle"])),
});

export type SendMessageRequest = typeof SendMessageRequest.Type;

export const OperatorMessageResult = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
  factoryId: Schema.String,
  senderKind: Schema.Literal("operator"),
  senderSlot: Schema.Null,
  recipient: Schema.String,
  body: Schema.String,
  delivery: Schema.Literals(["after_turn", "when_idle"]),
  kind: Schema.Literal("ordinary"),
  ticket: Schema.Null,
  requestId: Schema.Null,
  delegationId: Schema.Null,
  status: Schema.Literal("unbound"),
});

export type OperatorMessageResult = typeof OperatorMessageResult.Type;

export const isOperatorMessageResult = Schema.is(OperatorMessageResult);

export const messagePath = (id: string): string => `${MESSAGES_PATH}/${encodeURIComponent(id)}`;

/** Immutable correlation fields accompany a disposition and its durable history event.
 * Request/delegation failure handling consumes this result; it is not performed here. */
export const MessageDispositionResult = Schema.Struct({
  id: Schema.String,
  factoryId: Schema.String,
  slot: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["ordinary", "request_notice", "delegation_notice", "reply", "resume_notice"]),
  requestId: Schema.NullOr(Schema.String),
  delegationId: Schema.NullOr(Schema.String),
  ticket: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["indeterminate", "bound", "dropped"]),
  /** Open descendants at inspection/action time; older daemons may omit this field. */
  descendantDelegations: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type MessageDispositionResult = typeof MessageDispositionResult.Type;

export const isMessageDispositionResult = Schema.is(MessageDispositionResult);

export const MessageDispositionRequest = Schema.Struct({ confirmed: Schema.optionalKey(Schema.Boolean) });
