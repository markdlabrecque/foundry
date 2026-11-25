/** Asynchronous request acceptance (PRD §6.5). Reply, selection and expiry are separate handlers. */
import { randomUUID } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { acceptMessage } from "./agent-message.js";
import type { MessageAcceptanceGuards } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { PlannedSlot } from "./slots.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler } from "./submissions.js";

const RequestArgs = Schema.Struct({
  recipient: Schema.NonEmptyString,
  body: Schema.String,
  timeoutMs: Schema.Number,
  delivery: Schema.optional(Schema.Literals(["after_turn", "when_idle"])),
});

/**
 * Returns only after the request, its unbound notice and submission commit, never after delivery
 * or a reply. Assignment and budget seams are the same transaction-local guards as ordinary
 * messages. Routing later binds the notice and records the selected recipient slot.
 * `deadline` is an absolute Unix timestamp in milliseconds, persisted once and replayed unchanged.
 */
export const agentRequestHandler = (slots: ReadonlyArray<PlannedSlot>, guards: MessageAcceptanceGuards = {}): ToolHandler =>
  (change, call) => Effect.gen(function* () {
    const args = yield* Schema.decodeUnknownEffect(RequestArgs)(call.args).pipe(
      Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "agent_request needs recipient, body, positive integer timeoutMs and optional after_turn/when_idle delivery" })),
    );

    const acceptedAt = yield* Clock.currentTimeMillis;
    const deadline = acceptedAt + args.timeoutMs;

    if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0 || !Number.isSafeInteger(deadline)) {
      return yield* new ToolRefusal({ code: "invalid_arguments", detail: "timeoutMs must be a positive safe integer with a safe absolute deadline" });
    }

    if (!slots.some((slot) => slot.factoryId === call.factoryId && slot.station.address === args.recipient)) {
      return yield* new ToolRefusal({ code: "unknown_recipient", detail: `no station ${args.recipient} in your factory` });
    }

    const requestId = randomUUID();
    const ticket = guards.assignmentTicket === undefined ? null : yield* guards.assignmentTicket(change, call.factoryId, call.slotId);

    const notice = yield* acceptMessage(change, {
      factoryId: call.factoryId, senderSlot: call.slotId, recipient: args.recipient,
      body: args.body, delivery: args.delivery ?? "after_turn", kind: "request_notice",
      correlation: { requestId, ticket },
    }, guards);

    yield* change.query(
      `INSERT INTO agent_request (id, factory_id, requester_slot, recipient, ticket_number, notice_id, status, accepted_at, deadline)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [requestId, call.factoryId, call.slotId, args.recipient, ticket, notice.id, acceptedAt, deadline],
    );
    yield* change.recordHistory({
      factoryId: call.factoryId, kind: "request.accepted", subject: requestId,
      detail: { requesterSlot: call.slotId, recipient: args.recipient, noticeId: notice.id, deadline },
      records: [slotRecord(call.slotId), ...(ticket === null ? [] : [ticketRecord(ticket)])],
    });

    return { requestId, deadline };
  });
