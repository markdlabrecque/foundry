/** Durable acceptance only (PRD §6.1–3). Routing and delivery consume committed unbound rows later. */
import { randomUUID } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import type { PlannedSlot } from "./slots.js";
import type { Change, StoreError } from "./store.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolCallContext, ToolHandler } from "./submissions.js";

export type MessageKind = "ordinary" | "request_notice" | "delegation_notice" | "reply" | "resume_notice";

export type MessageDelivery = "after_turn" | "when_idle";

/** Trusted daemon input, never a decoded worker frame. Correlation is supplied by request/delegation handlers. */
export type MessageAcceptance = {
  readonly factoryId: string;
  readonly recipient: string;
  readonly body: string;
  readonly delivery: MessageDelivery;
  readonly kind: MessageKind;
  readonly correlation?: {
    readonly requestId?: string;
    readonly delegationId?: string;
    /** Explicit null preserves a correlated request's lack of ticket, rather than using an assignment. */
    readonly ticket: number | null;
  };
} & (
  | { readonly senderKind?: "agent"; readonly senderSlot: string }
  | { readonly senderKind: "operator"; readonly senderSlot: null }
);

export type AcceptedMessage = {
  readonly id: string;
  readonly sequence: number;
  readonly factoryId: string;
  readonly senderKind: "agent" | "operator";
  readonly senderSlot: string | null;
  readonly recipient: string;
  readonly body: string;
  readonly delivery: MessageDelivery;
  readonly kind: MessageKind;
  readonly ticket: number | null;
  readonly requestId: string | null;
  readonly delegationId: string | null;
  readonly status: "unbound";
};

export interface MessageAcceptanceGuards {
  /** Read the active assignment inside this transaction. Until assignment exists, there is no ticket. */
  readonly assignmentTicket?: (change: Change, factoryId: string, slotId: string) => Effect.Effect<number | null, StoreError | ToolRefusal>;
  /**
   * Charge/check a ticket's budget here, in the acceptance transaction. May write the pause and
   * approval when the limit is reached, or refuse without retaining any effects. No network waits.
   */
  readonly budget?: (change: Change, message: AcceptedMessage) => Effect.Effect<void, StoreError | ToolRefusal>;
}

/**
 * Acceptance seam for later routing/request handlers. Call inside a submission's change, never
 * send from here: the returned record is provisional until the enclosing transaction commits.
 */
export const acceptMessage = (change: Change, input: MessageAcceptance, guards: MessageAcceptanceGuards = {}) =>
  Effect.gen(function* () {
    const senderKind = input.senderKind ?? "agent";

    const ticket = input.senderKind === "operator" ? null : input.correlation !== undefined
      ? input.correlation.ticket
      : guards.assignmentTicket === undefined ? null : yield* guards.assignmentTicket(change, input.factoryId, input.senderSlot);

    const id = randomUUID();
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* change.query<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM message WHERE factory_id = ?`, [input.factoryId],
    );

    const sequence = rows[0]?.sequence ?? 1;

    const message: AcceptedMessage = {
      id, sequence, factoryId: input.factoryId, senderKind, senderSlot: input.senderSlot,
      recipient: input.recipient, body: input.body, delivery: input.delivery, kind: input.kind,
      ticket, requestId: input.correlation?.requestId ?? null,
      delegationId: input.correlation?.delegationId ?? null, status: "unbound",
    };

    if (senderKind === "agent" && ticket !== null && guards.budget !== undefined) {yield* guards.budget(change, message);}

    yield* change.query(
      `INSERT INTO message (id, factory_id, sequence, sender_kind, sender_slot, recipient, body, delivery, kind,
         ticket_number, request_id, delegation_id, status, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unbound', ?)`,
      [id, input.factoryId, sequence, senderKind, input.senderSlot, input.recipient, input.body, input.delivery,
        input.kind, ticket, message.requestId, message.delegationId, now],
    );
    yield* change.recordHistory({
      factoryId: input.factoryId, kind: "message.accepted", subject: id,
      detail: { sequence, senderKind, senderSlot: input.senderSlot, recipient: input.recipient, kind: input.kind, delivery: input.delivery },
      records: [...(input.senderSlot === null ? [] : [slotRecord(input.senderSlot)]), ...(ticket === null ? [] : [ticketRecord(ticket)])],
    });

    return message;
  });

const MessageArgs = Schema.Struct({
  recipient: Schema.NonEmptyString,
  body: Schema.String,
  delivery: Schema.optional(Schema.Literals(["after_turn", "when_idle"])),
});

const decodeArgs = (call: ToolCallContext) => Schema.decodeUnknownEffect(MessageArgs)(call.args).pipe(
  Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "agent_message needs recipient, body and optional after_turn/when_idle delivery" })),
);

/** Scope and sender are owned by the accepted channel. Extra caller identity/correlation fields are ignored. */
export const agentMessageHandler = (slots: ReadonlyArray<PlannedSlot>, guards: MessageAcceptanceGuards = {}): ToolHandler =>
  (change, call) => Effect.gen(function* () {
    const args = yield* decodeArgs(call);

    if (!slots.some((slot) => slot.factoryId === call.factoryId && slot.station.address === args.recipient)) {
      return yield* new ToolRefusal({ code: "unknown_recipient", detail: `no station ${args.recipient} in your factory` });
    }

    return yield* acceptMessage(change, {
      factoryId: call.factoryId, senderSlot: call.slotId, recipient: args.recipient,
      body: args.body, delivery: args.delivery ?? "after_turn", kind: "ordinary",
    }, guards);
  });
