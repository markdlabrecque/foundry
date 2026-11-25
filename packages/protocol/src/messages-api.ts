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
