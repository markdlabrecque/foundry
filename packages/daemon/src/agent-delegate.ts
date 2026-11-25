/** Tracked obligation acceptance (PRD §6.5). Resolution and depth limits are separate handlers. */
import { randomUUID } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { acceptMessage } from "./agent-message.js";
import type { MessageAcceptanceGuards } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { PlannedSlot } from "./slots.js";
import { ToolRefusal } from "./submissions.js";
import type { ToolHandler } from "./submissions.js";

const DelegateArgs = Schema.Struct({
  recipient: Schema.NonEmptyString,
  body: Schema.String,
  parentDelegationId: Schema.optional(Schema.NonEmptyString),
  delivery: Schema.optional(Schema.Literals(["after_turn", "when_idle"])),
});

interface RootRow {
  readonly id: string;
  readonly ticket_number: number;
  readonly depth: number;
}

/** Root and parent identities are read from durable state, never accepted from worker arguments.
 * A child can only be delegated by its open parent's selected recipient. Notices bind later,
 * through the ordinary station router; acceptance does not wait for a running recipient. */
export const agentDelegateHandler = (slots: ReadonlyArray<PlannedSlot>, guards: MessageAcceptanceGuards = {}): ToolHandler =>
  (change, call) => Effect.gen(function* () {
    const args = yield* Schema.decodeUnknownEffect(DelegateArgs)(call.args).pipe(
      Effect.mapError(() => new ToolRefusal({ code: "invalid_arguments", detail: "agent_delegate needs recipient, body, optional parentDelegationId and after_turn/when_idle delivery" })),
    );

    if (!slots.some((slot) => slot.factoryId === call.factoryId && slot.station.address === args.recipient)) {
      return yield* new ToolRefusal({ code: "unknown_recipient", detail: `no station ${args.recipient} in your factory` });
    }

    const roots = args.parentDelegationId === undefined
      ? yield* change.query<RootRow>(
        `SELECT id, ticket_number, 0 AS depth FROM assignment WHERE factory_id = ? AND slot_id = ? AND status = 'active'`,
        [call.factoryId, call.slotId],
      )
      : yield* change.query<RootRow>(
        `SELECT a.id, a.ticket_number, d.depth FROM delegation d JOIN assignment a ON a.id = d.root_assignment
         AND a.factory_id = d.factory_id WHERE d.id = ? AND d.factory_id = ? AND d.recipient_slot = ?
         AND d.status = 'open' AND a.status = 'active'`,
        [args.parentDelegationId, call.factoryId, call.slotId],
      );

    const root = roots[0];

    if (root === undefined) {
      return yield* new ToolRefusal({ code: "delegation_scope", detail: "requires an active assignment or an open parent selected for your slot under an active root assignment" });
    }

    const delegationId = randomUUID();
    const depth = root.depth + 1;
    const acceptedAt = yield* Clock.currentTimeMillis;

    const notice = yield* acceptMessage(change, {
      factoryId: call.factoryId, senderSlot: call.slotId, recipient: args.recipient,
      body: args.body, delivery: args.delivery ?? "after_turn", kind: "delegation_notice",
      correlation: { delegationId, ticket: root.ticket_number },
    }, guards);

    yield* change.query(
      `INSERT INTO delegation (id, factory_id, root_assignment, parent_id, delegating_slot, recipient,
         depth, notice_id, status, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [delegationId, call.factoryId, root.id, args.parentDelegationId ?? null, call.slotId,
        args.recipient, depth, notice.id, acceptedAt],
    );
    yield* change.recordHistory({ factoryId: call.factoryId, kind: "delegation.accepted", subject: delegationId,
      detail: { rootAssignment: root.id, parentId: args.parentDelegationId ?? null, delegatingSlot: call.slotId,
        recipient: args.recipient, depth, noticeId: notice.id },
      records: [slotRecord(call.slotId), ticketRecord(root.ticket_number)],
    });

    return { delegationId, rootAssignment: root.id, parentDelegationId: args.parentDelegationId ?? null, depth, noticeId: notice.id };
  });
