/** The accepted channel's recovery barrier: no new assignments until resumption and delivery attach. */
import { Predicate } from "effect";
import type { Hello } from "@foundry/protocol";
import type { AcceptedConnection, ClaimedSlot } from "./channel/server.js";
import type { ChannelAssignmentGate } from "./channel-assignment-gate.js";
import type { createReconciler } from "./reconciliation.js";
import type { createPrimer } from "./priming.js";
import type { createMessageDelivery } from "./message-delivery.js";

export interface ConnectionRecoveryOptions {
  readonly gate: ChannelAssignmentGate;
  readonly reconciler: Pick<ReturnType<typeof createReconciler>, "reconcile" | "resumeAssignment">;
  readonly primer: Pick<ReturnType<typeof createPrimer>, "prime">;
  readonly delivery: Pick<ReturnType<typeof createMessageDelivery>, "attach">;
  readonly notTakingWork: (reason: string) => void;
  readonly onError: (cause: unknown) => void;
}

/** Acceptance closes the gate synchronously; closure also invalidates any late recovery completion. */
export const recoverConnection = (
  options: ConnectionRecoveryOptions, slot: ClaimedSlot, hello: Hello, accepted: AcceptedConnection,
): Promise<void> => {
  const gated = options.gate.accepted(slot);
  void accepted.closed?.then(gated.closed);

  return options.reconciler.reconcile(slot, hello, accepted).then(async (comparison) => {
    const primed = options.primer.prime(slot, hello, accepted);
    const outcome = await primed.outcome;

    if (Predicate.isTagged(outcome, "Sent") || Predicate.isTagged(outcome, "Reconnect")) {
      await options.reconciler.resumeAssignment(slot, primed.connection, comparison.interruptedAssignmentId);
      options.delivery.attach(slot, primed.connection);
      gated.reconciled();
    } else if (!Predicate.isTagged(outcome, "Closed")) {
      options.notTakingWork(outcome._tag);
    }
  }).catch(options.onError);
};
