/** Explicit operator disposition of an ambiguous copy. No retry or receipt may resolve this hold. */
import { Data, Effect, Option, Schema } from "effect";
import { MessageDispositionResult } from "@foundry/protocol/messages-api";
import { closeOpenHoldIn } from "./holds.js";
import type { Query, Store } from "./store.js";

export class MessageDispositionError extends Data.TaggedError("MessageDispositionError")<{
  readonly code: "not_found" | "not_indeterminate" | "confirmation_required";
  readonly message: string;
}> {}

const inspect = (query: Query, id: string) => Effect.gen(function* () {
  const rows = yield* query(`SELECT id, factory_id AS factoryId, bound_slot AS slot, kind,
    request_id AS requestId, delegation_id AS delegationId, ticket_number AS ticket, status FROM message WHERE id = ?`, [id]);

  const row = rows[0];

  if (row === undefined) {return yield* new MessageDispositionError({ code: "not_found", message: `no message ${id}` });}

  const result = Schema.decodeUnknownOption(MessageDispositionResult)(row);

  if (Option.isNone(result) || result.value.status !== "indeterminate") {
    return yield* new MessageDispositionError({ code: "not_indeterminate", message: `message ${id} is not indeterminate` });
  }

  return result.value;
});

export const createMessageDisposition = (store: Store) => ({
  inspect: (id: string) => inspect(store.read, id),
  act: (id: string, action: "resend" | "drop", confirmed = false) => store.change((change) => Effect.gen(function* () {
    const message = yield* inspect(change.query, id);

    if (action === "drop" && !confirmed) {
      return yield* new MessageDispositionError({ code: "confirmation_required", message: "dropping a message requires confirmation of its request/delegation loss" });
    }

    const result: MessageDispositionResult = { ...message, status: action === "resend" ? "bound" : "dropped" };
    yield* change.query(`UPDATE message SET status = ? WHERE id = ?`, [result.status, id]);
    yield* closeOpenHoldIn(change, { factoryId: message.factoryId, kind: "indeterminate_message", subject: id }, "resolved");
    yield* closeOpenHoldIn(change, { factoryId: message.factoryId, kind: "stuck_worker", subject: id }, "cleared");
    yield* change.recordHistory({ factoryId: message.factoryId, kind: action === "drop" ? "message.dropped" : "message.resend_requested",
      subject: id, detail: { ...result, possibleDuplicate: action === "resend" },
      records: message.ticket === null ? [] : [{ kind: "ticket", id: String(message.ticket) }] });

    return result;
  })),
});

export type MessageDisposition = ReturnType<typeof createMessageDisposition>;
