/**
 * Agent tool calls as submissions (PRD §6.1, §10.1). One submission record per call, keyed by the
 * launch the channel was claimed for plus Pi's tool call ID. The record, every effect of the call
 * and the result returned commit in one transaction; the result is sent only after that commit.
 *
 * A retry of a committed call returns the stored result and changes nothing. Two calls with the
 * same arguments but different call IDs are two submissions. A call from a frozen slot is refused
 * (PRD §5.3) and nothing is committed; a retry of a call that committed before the freeze still
 * gets its stored result, because replaying it changes nothing and tells the worker the truth.
 */
import { Clock, Data, Effect, Schema } from "effect";
import { ToolRefusalCode } from "@foundry/protocol";
import type { ToolCall, ToolCallOutcome } from "@foundry/protocol";
import type { ClaimedSlot } from "./channel/server.js";
import { openSlotGate } from "./freeze.js";
import type { SlotGate } from "./freeze.js";
import { slotRecord } from "./history-records.js";
import type { Change, Query, Store, StoreError } from "./store.js";

/** The call a handler serves, attributed to the slot and launch its channel was claimed for. */
export interface ToolCallContext {
  readonly factoryId: string;
  readonly slotId: string;
  readonly launchId: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: Schema.Json;
}

/** A handler's refusal: the transaction rolls back and the worker gets `code` with nothing committed. */
export class ToolRefusal extends Data.TaggedError("ToolRefusal")<{
  readonly code: string;
  readonly detail: string;
}> {}

/**
 * Serves one tool inside the submission's transaction. Its writes are the call's effects; its
 * value is the result stored and returned. It must record any history its effects need.
 *
 * It runs holding the store's only write lock, so it must not wait on anything outside the store
 * (the network, a worker, a timer): every other daemon write waits behind it. Refusal codes must be
 * non-empty, or the result frame cannot be encoded and the worker's call never settles.
 */
export type ToolHandler = (change: Change, call: ToolCallContext) => Effect.Effect<Schema.Json, ToolRefusal | StoreError>;

export interface SubmissionsOptions {
  readonly store: Store;
  /** The tools the daemon serves, by name. */
  readonly handlers: ReadonlyMap<string, ToolHandler>;
  /** Frozen slots have their calls refused. Defaults to a gate that refuses nothing. */
  readonly gate?: SlotGate;
}

/** Answers tool calls arriving on accepted channels; pass as the channel server's `toolCalls`. */
export interface Submissions {
  /** Resolves only once the outcome is final: committed (and durable) or refused (nothing kept). */
  submit(slot: ClaimedSlot, call: ToolCall): Promise<ToolCallOutcome>;
}

/** The call was committed earlier; its stored result is the answer. Rolls back the empty change. */
class AlreadyCommitted extends Data.TaggedError("AlreadyCommitted")<{ readonly value: Schema.Json }> {}

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const committed = (value: Schema.Json): ToolCallOutcome => ({ status: "committed", value });

const refused = (code: string, detail: string): ToolCallOutcome => ({ status: "refused", code, detail });

const storedResult = (query: Query, launchId: string, callId: string) =>
  Effect.map(
    query<{ result: string }>(`SELECT result FROM submission WHERE launch_id = ? AND call_id = ?`, [launchId, callId]),
    (rows) => (rows[0] === undefined ? undefined : decodeStored(rows[0].result)),
  );

export const createSubmissions = (options: SubmissionsOptions): Submissions => {
  const gate = options.gate ?? openSlotGate;

  const submit = (slot: ClaimedSlot, call: ToolCall): Promise<ToolCallOutcome> => {
    const context: ToolCallContext = {
      factoryId: slot.factoryId,
      slotId: slot.slotId,
      launchId: slot.launchId,
      callId: call.callId,
      tool: call.tool,
      args: call.args,
    };

    // Checked inside the transaction, so a retry racing the original sees its committed row.
    const program = options.store
      .change((change) =>
        Effect.gen(function* () {
          const previous = yield* storedResult(change.query, slot.launchId, call.callId);

          if (previous !== undefined) {return yield* new AlreadyCommitted({ value: previous });}

          if (gate.isFrozen(slot)) {
            return yield* new ToolRefusal({ code: ToolRefusalCode.slotFrozen, detail: `slot ${slot.slotId} is frozen` });
          }

          const handler = options.handlers.get(call.tool);

          if (handler === undefined) {
            return yield* new ToolRefusal({ code: ToolRefusalCode.unknownTool, detail: `no tool named ${call.tool}` });
          }

          const value = yield* handler(change, context);
          const now = yield* Clock.currentTimeMillis;
          yield* change.query(
            `INSERT INTO submission (launch_id, call_id, factory_id, slot_id, tool, result, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [slot.launchId, call.callId, slot.factoryId, slot.slotId, call.tool, JSON.stringify(value), now],
          );
          yield* change.recordHistory({
            factoryId: slot.factoryId,
            kind: "submission.recorded",
            subject: slot.slotId,
            detail: { launchId: slot.launchId, callId: call.callId, tool: call.tool },
            records: [slotRecord(slot.slotId)],
          });

          return value;
        }),
      )
      .pipe(
        Effect.map(committed),
        Effect.catchTag("AlreadyCommitted", (e) => Effect.succeed(committed(e.value))),
        Effect.catchTag("ToolRefusal", (e) => Effect.succeed(refused(e.code, e.detail))),
        // A failed statement or commit rolls the whole call back; nothing of it was kept.
        Effect.catchTag("StoreError", (e) => Effect.succeed(refused(ToolRefusalCode.notCommitted, e.message))),
      );

    return Effect.runPromise(program);
  };

  return { submit };
};
