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
 * Used only when no `storedConversation` is given. Operator reset will need an `unbind` here.
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
  /** The host and the daemon's records disagree on which launch holds the slot. */
  ownershipUnknown: "ownership_unknown",
} as const;

const terminal = (code: string, detail: string): SlotClaimResult => ({
  accepted: false,
  reason: { kind: "terminal", code, detail },
});

const retryable = (code: string, detail: string): HelloRejectReason => ({ kind: "retryable", code, detail });

export interface HostSlotClaimOptions {
  readonly host: LaunchInventory;
  /** Defaults to process-local bindings. Ignored when `storedConversation` is given. */
  readonly conversations?: SlotConversations;
  /**
   * The conversation the daemon issued the slot and recorded (PRD §10.1), read afresh on each hello,
   * so a changed conversation is recognized after a daemon restart. When given, a hello must present
   * it; a slot with none recorded yet accepts any. Nothing is bound by the claim.
   */
  readonly storedConversation?: (factoryId: string, slotId: string) => Promise<string | undefined>;
  /**
   * Called before a hello presenting a changed conversation is refused, so the slot can be frozen
   * (PRD §3.2: P0 cannot adopt a changed conversation). The refusal waits for it.
   */
  readonly onConversationChanged?: (change: ConversationChange) => Promise<void>;
  /**
   * The launch the daemon records as the slot's current one, or `null`. When given, only that launch
   * speaks for the slot (PRD §3.2). A host-live launch that is not it, or a recorded launch the host
   * does not know, is unknown ownership: refused as retryable, and its conversation is not bound. At
   * start the scheduler freezes such slots; freezing on a host lost while the daemon keeps running
   * is not handled here. Default: any launch the host reports live is accepted.
   */
  readonly currentLaunch?: (factoryId: string, slotId: string) => Promise<string | null>;
  /**
   * Resolves once scheduling queued so far has recorded what it launched or claimed. Awaited before
   * `currentLaunch` is read, so a worker that dials between the host's start reply and its record
   * is not refused (the extension does not redial yet). Default: nothing to wait for.
   */
  readonly settled?: () => Promise<void>;
}

/** A hello that presented a different conversation than the one its slot is bound to. */
export interface ConversationChange {
  readonly factoryId: string;
  readonly slotId: string;
  readonly launchId: string;
  readonly boundRef: string;
  readonly presentedRef: string;
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

      if (options.currentLaunch !== undefined) {await options.settled?.();}

      if (record === undefined) {
        // A host that lost its registry cannot vouch for a launch the daemon recorded: unknown, not refused.
        if (options.currentLaunch !== undefined && (await options.currentLaunch(hello.factoryId, hello.slotId)) === hello.launchId) {
          return {
            accepted: false,
            reason: retryable(SlotClaimRejectCode.ownershipUnknown, `the worker host does not know launch ${hello.launchId}, which the daemon recorded`),
          };
        }

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

      // An orphan the host reports live is never accepted in the slot's name, nor its conversation bound.
      if (options.currentLaunch !== undefined && (await options.currentLaunch(record.factoryId, record.slotId)) !== record.launchId) {
        return {
          accepted: false,
          reason: retryable(
            SlotClaimRejectCode.ownershipUnknown,
            `launch ${record.launchId} is live on the worker host but is not the recorded launch of slot ${record.slotId}`,
          ),
        };
      }

      // In-memory bindings are checked and set without awaiting, so concurrent hellos cannot both bind.
      const bound =
        options.storedConversation === undefined
          ? conversations.get(record.factoryId, record.slotId)
          : await options.storedConversation(record.factoryId, record.slotId);

      if (bound !== undefined && bound !== hello.conversationRef) {
        await options.onConversationChanged?.({
          factoryId: record.factoryId,
          slotId: record.slotId,
          launchId: record.launchId,
          boundRef: bound,
          presentedRef: hello.conversationRef,
        });

        return terminal(
          SlotClaimRejectCode.conversationChanged,
          `slot ${record.slotId} is bound to a different conversation than the one presented`,
        );
      }

      if (bound === undefined && options.storedConversation === undefined) {conversations.bind(record.factoryId, record.slotId, hello.conversationRef);}

      return {
        accepted: true,
        slot: { factoryId: record.factoryId, slotId: record.slotId, launchId: record.launchId },
      };
    },
  };
};
