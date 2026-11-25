/**
 * The conversation adapter: the one path by which Foundry content (a prime or
 * a message) enters the worker's Pi conversation, and the place its receipt is
 * decided (PRD §5.5, §6.3). Injecting does not issue a receipt; the receipt
 * fires only once the ID is found in the session file Pi would restore from.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FOUNDRY_MESSAGE_TYPE,
  type FoundryInjection,
  type FoundryMessageDetails,
  ReceiptIssuer,
  sessionFileHistory,
} from "./receipts.js";

export interface InjectOptions {
  /** Start a turn if Pi is idle. A prime never does; delivery policy decides for messages. */
  readonly triggerTurn?: boolean;
}

export interface ConversationAdapter {
  /** Inject into the conversation and start awaiting its receipt. Not itself a receipt. */
  inject(injection: FoundryInjection, options?: InjectOptions): void;
  /** Issue receipts for injected IDs now recoverable; returns the IDs receipted. */
  check(): readonly string[];
  /** Injected IDs whose receipt has not been issued yet. */
  pending(): readonly string[];
}

export interface ConversationAdapterOptions {
  /** Called once per ID, when it is first found in recoverable history. */
  readonly onReceipt: (id: string) => void;
}

/**
 * Register the adapter on a Pi extension. It re-checks after the lifecycle
 * points where Pi persists entries: after each injection, at each turn end
 * (assistant and tool results written), when a run settles and after a compaction.
 */
export const createConversationAdapter = (pi: ExtensionAPI, options: ConversationAdapterOptions): ConversationAdapter => {
  let sessionFile: () => string | undefined = () => undefined;
  const issuer = new ReceiptIssuer(
    sessionFileHistory(() => sessionFile()),
    options.onReceipt,
  );

  pi.on("session_start", (_event, ctx) => {
    sessionFile = () => ctx.sessionManager.getSessionFile();
    issuer.check();
  });
  // `message_end` handlers run before Pi persists that message, so each one
  // checks what earlier events wrote; the boundary events below catch the rest.
  pi.on("message_end", () => void issuer.check());
  pi.on("turn_end", () => void issuer.check());
  pi.on("agent_settled", () => void issuer.check());
  pi.on("session_compact", () => void issuer.check());

  return {
    inject(injection, injectOptions = {}) {
      issuer.expect(injection.id);
      const details: FoundryMessageDetails = { foundryId: injection.id, kind: injection.kind };
      pi.sendMessage(
        { customType: FOUNDRY_MESSAGE_TYPE, content: injection.content, display: true, details },
        { triggerTurn: injection.kind === "prime" ? false : (injectOptions.triggerTurn ?? false) },
      );
      // An idle session appends at once; if its file already exists the entry is now recoverable.
      issuer.check();
    },
    check: () => issuer.check(),
    pending: () => issuer.pending(),
  };
};
