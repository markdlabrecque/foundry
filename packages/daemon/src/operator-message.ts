/** Operator sends enter the same committed message log as worker sends, never a second inbox. */
import { Data, Effect } from "effect";
import type { SendMessageRequest } from "@foundry/protocol/messages-api";
import { acceptMessage } from "./agent-message.js";
import type { AcceptedMessage, MessageAcceptanceGuards } from "./agent-message.js";
import type { PlannedSlot } from "./slots.js";
import type { Store, StoreError } from "./store.js";
import type { ToolRefusal } from "./submissions.js";

export class OperatorMessageError extends Data.TaggedError("OperatorMessageError")<{
  readonly code: "factory_required" | "unknown_factory" | "unknown_recipient";
  readonly message: string;
}> {}

export interface OperatorMessages {
  readonly send: (request: SendMessageRequest) => Effect.Effect<AcceptedMessage, StoreError | ToolRefusal | OperatorMessageError>;
}

export const createOperatorMessages = (options: {
  readonly store: Store;
  readonly factories: () => ReadonlyArray<string>;
  readonly slots: ReadonlyArray<PlannedSlot>;
  /** Same acceptance guards as agent sends; operator acceptance must bypass assignment and budget. */
  readonly guards?: MessageAcceptanceGuards;
}): OperatorMessages => ({
  send: (request) => Effect.gen(function* () {
    const loaded = options.factories();
    const factory = request.factory ?? (loaded.length === 1 ? loaded[0] : undefined);

    if (factory === undefined) {
      return yield* new OperatorMessageError({ code: "factory_required", message: "Name a loaded factory with --factory" });
    }

    if (!loaded.includes(factory)) {
      return yield* new OperatorMessageError({ code: "unknown_factory", message: `No factory "${factory}" is loaded` });
    }

    if (!options.slots.some((slot) => slot.factoryId === factory && slot.station.address === request.recipient)) {
      return yield* new OperatorMessageError({ code: "unknown_recipient", message: `No station ${request.recipient} in factory "${factory}"` });
    }

    return yield* options.store.change((change) => acceptMessage(change, {
      factoryId: factory, senderKind: "operator", senderSlot: null,
      recipient: request.recipient, body: request.body, delivery: request.delivery ?? "after_turn", kind: "ordinary",
    }, options.guards));
  }),
});
