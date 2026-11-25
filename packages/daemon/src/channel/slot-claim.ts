/**
 * The host-confirmed slot claim (PRD §3.2): a hello is accepted only when the
 * Worker Host reports its launch as the current, live launch of the slot it
 * names, and its conversation reference matches the one the slot is bound to.
 *
 * The accepted slot is built from the host's launch record, never from the
 * hello, so the connection speaks for what the host confirmed.
 */
import type { Hello, HelloRejectReason } from "@foundry/protocol";
import type { SlotClaim, SlotClaimResult } from "./server.js";

/**
 * The fields of a Worker Host launch record the claim relies on. The host's
 * `LaunchRecord` satisfies it, so `connectHost(...)` can serve as the inventory.
 */
export interface LaunchReport {
  readonly launchId: string;
  readonly factoryId: string;
  readonly slotId: string;
  readonly liveness: "live" | "gone";
}

/** Where the claim asks the Worker Host which launches it owns. */
export interface LaunchInventory {
  inventory(): Promise<ReadonlyArray<LaunchReport>>;
}

/**
 * The conversation reference each slot is bound to. A conversation outlives a
 * launch, so this is keyed by slot, not by launch.
 *
 * Operator reset and unfreeze (11b, 43a) will need an `unbind`/`rebind` here.
 */
export interface SlotConversations {
  get(factoryId: string, slotId: string): string | undefined;
  bind(factoryId: string, slotId: string, conversationRef: string): void;
}

const key = (factoryId: string, slotId: string): string => JSON.stringify([factoryId, slotId]);

/** Process-local bindings; the first accepted hello for a slot binds its conversation. */
export const inMemorySlotConversations = (): SlotConversations => {
  const refs = new Map<string, string>();

  return {
    get: (factoryId, slotId) => refs.get(key(factoryId, slotId)),
    bind: (factoryId, slotId, conversationRef) => void refs.set(key(factoryId, slotId), conversationRef),
  };
};

/** Refusal codes added by the host-confirmed slot claim. */
export const SlotClaimRejectCode = {
  /** The host reports no launch with this ID. */
  launchUnknown: "launch_unknown",
  /** The host has the launch, but in a different factory or slot than the hello claims. */
  launchIdentityConflict: "launch_identity_conflict",
  /** The host has the launch, but it is no longer the slot's current one. */
  launchStale: "launch_stale",
  /** The slot is bound to a different conversation (`/new`, `/resume`, fork, clone). */
  conversationChanged: "conversation_changed",
  /** The host could not be asked; nothing is known about the launch. */
  hostUnreachable: "host_unreachable",
} as const;

const terminal = (code: string, detail: string): SlotClaimResult => ({
  accepted: false,
  reason: { kind: "terminal", code, detail },
});

const retryable = (code: string, detail: string): HelloRejectReason => ({ kind: "retryable", code, detail });

export interface HostSlotClaimOptions {
  readonly host: LaunchInventory;
  /** Defaults to process-local bindings. */
  readonly conversations?: SlotConversations;
}

export const createHostSlotClaim = (options: HostSlotClaimOptions): SlotClaim => {
  const conversations = options.conversations ?? inMemorySlotConversations();

  return {
    async claim(hello: Hello): Promise<SlotClaimResult> {
      let launches: ReadonlyArray<LaunchReport>;

      try {
        launches = await options.host.inventory();
      } catch (error) {
        return {
          accepted: false,
          reason: retryable(SlotClaimRejectCode.hostUnreachable, `worker host inventory failed: ${String(error)}`),
        };
      }

      const record = launches.find((launch) => launch.launchId === hello.launchId);

      // A host restart that lost its registry could make a live launch look unknown here;
      // PRD §3.2 treats unknown ownership as retryable, which 43a will distinguish.
      if (record === undefined) {
        return terminal(SlotClaimRejectCode.launchUnknown, `the worker host reports no launch ${hello.launchId}`);
      }

      if (record.factoryId !== hello.factoryId || record.slotId !== hello.slotId) {
        return terminal(
          SlotClaimRejectCode.launchIdentityConflict,
          `launch ${record.launchId} belongs to slot ${record.slotId} of factory ${record.factoryId}, ` +
            `not slot ${hello.slotId} of factory ${hello.factoryId}`,
        );
      }

      if (record.liveness !== "live") {
        return terminal(
          SlotClaimRejectCode.launchStale,
          `launch ${record.launchId} is not the current launch of slot ${record.slotId}`,
        );
      }

      // Checked and bound without awaiting, so concurrent hellos for one slot cannot both bind.
      const bound = conversations.get(record.factoryId, record.slotId);

      if (bound !== undefined && bound !== hello.conversationRef) {
        return terminal(
          SlotClaimRejectCode.conversationChanged,
          `slot ${record.slotId} is bound to a different conversation than the one presented`,
        );
      }

      if (bound === undefined) {conversations.bind(record.factoryId, record.slotId, hello.conversationRef);}

      return {
        accepted: true,
        slot: { factoryId: record.factoryId, slotId: record.slotId, launchId: record.launchId },
      };
    },
  };
};
