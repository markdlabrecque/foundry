/**
 * The Tool Set check at every `hello` (PRD §3.2 "Tool Set", §5.3, §14).
 *
 * The tools a worker reports are compared with its station's effective Tool Set: a named tool
 * missing, an extra one present, or a tool whose source is not the expected one (a built-in not
 * from Pi, an agent tool not from the Foundry extension, a named tool from another extension) is a
 * mismatch. A mismatched hello is refused with the terminal reason `tool_set_mismatch`, the slot is
 * frozen with the discrepancy as its hold's evidence, and the host stops the launch.
 *
 * Unfreezing after a mismatch starts a new launch in the same conversation and checks its hello
 * the same way; the slot unfreezes only when that hello matches. A corrected YAML takes a daemon
 * restart, which the freeze survives.
 *
 * Sources are compared as canonical paths (macOS `/var` is `/private/var`), since the extension
 * reports the path Pi was given.
 */
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Effect, Option, Schema } from "effect";
import { builtinToolSource, REGISTERED_AGENT_TOOLS } from "@foundry/protocol";
import type { Hello, ReportedTool } from "@foundry/protocol";
import type { HoldEvidence } from "@foundry/protocol/holds";
import { TOOL_SET_RECHECK_HELLO_TIMEOUT_MS } from "@foundry/protocol/slots-api";
import type { SlotClaim, SlotClaimResult } from "./channel/server.js";
import { toolSetOf, ToolSource } from "./config/tool-set.js";
import type { EffectiveStation } from "./config/resolve.js";
import type { CauseCheck, SlotFreezer, SlotRef } from "./freeze.js";
import { listOpenHolds } from "./holds.js";
import type { Store } from "./store.js";

/** One tool a worker should have, and the source the extension should report for it. */
export interface ExpectedTool {
  readonly name: string;
  readonly source: string;
}

/** The refusal code of a mismatched hello. */
export const TOOL_SET_MISMATCH = "tool_set_mismatch";

const AGENT_TOOLS_OFFERED: ReadonlySet<string> = new Set(REGISTERED_AGENT_TOOLS);

/**
 * A station's expected Tool Set as the extension reports it: Pi's built-ins as `builtin:<name>`,
 * the agent tools this build registers from the Foundry extension, and each named tool from the
 * extension the YAML names it on.
 */
export const expectedToolSet = (station: Pick<EffectiveStation, "extensions">, foundryExtension: string): ReadonlyArray<ExpectedTool> =>
  toolSetOf(station).flatMap(({ name, source }) =>
    ToolSource.$match(source, {
      Pi: () => [{ name, source: builtinToolSource(name) }],
      Foundry: () => (AGENT_TOOLS_OFFERED.has(name) ? [{ name, source: foundryExtension }] : []),
      Extension: ({ path }) => [{ name, source: path }],
    }),
  );

/** A named tool reported from another source than the expected one. */
export interface ReplacedTool {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ToolSetDiscrepancy {
  readonly missing: ReadonlyArray<ExpectedTool>;
  readonly extra: ReadonlyArray<ReportedTool>;
  readonly replaced: ReadonlyArray<ReplacedTool>;
}

/** An absolute path resolved through symlinks when it exists; any other source as given. */
export const canonicalSource = (source: string): string => {
  if (!isAbsolute(source)) {return source;}

  try {
    return realpathSync(source);
  } catch {
    return source;
  }
};

/** Compares reported with expected tools, order-free. Pure apart from `canonical`. */
export const compareToolSet = (
  expected: ReadonlyArray<ExpectedTool>,
  reported: ReadonlyArray<ReportedTool>,
  canonical: (source: string) => string = (source) => source,
): ToolSetDiscrepancy => {
  const wanted = new Set(expected.map((tool) => tool.name));
  const got = new Map(reported.map((tool) => [tool.name, tool.source]));

  return {
    missing: expected.filter((tool) => !got.has(tool.name)),
    extra: reported.filter((tool) => !wanted.has(tool.name)),
    replaced: expected.flatMap((tool) => {
      const actual = got.get(tool.name);

      return actual === undefined || canonical(actual) === canonical(tool.source) ? [] : [{ name: tool.name, expected: tool.source, actual }];
    }),
  };
};

export const isMatch = (discrepancy: ToolSetDiscrepancy): boolean =>
  discrepancy.missing.length === 0 && discrepancy.extra.length === 0 && discrepancy.replaced.length === 0;

const describe = (discrepancy: ToolSetDiscrepancy): string =>
  [
    ...discrepancy.missing.map((tool) => `missing ${tool.name} (${tool.source})`),
    ...discrepancy.extra.map((tool) => `extra ${tool.name} (${tool.source})`),
    ...discrepancy.replaced.map((tool) => `${tool.name} from ${tool.actual}, expected ${tool.expected}`),
  ].join("; ");

/** What the frozen-slot hold shows for a mismatch (PRD §10.2). */
const evidenceOf = (hello: Hello, discrepancy: ToolSetDiscrepancy): HoldEvidence => ({
  launchId: hello.launchId,
  conversationRef: hello.conversationRef,
  missing: discrepancy.missing.map((tool) => ({ name: tool.name, source: tool.source })),
  extra: discrepancy.extra.map((tool) => ({ name: tool.name, source: tool.source })),
  replaced: discrepancy.replaced.map((tool) => ({ name: tool.name, expected: tool.expected, actual: tool.actual })),
});

/** The Tool Set check of one hello the host claim accepted. */
export type HelloCheck =
  | { readonly matched: true; readonly launchId: string }
  | { readonly matched: false; readonly launchId: string; readonly evidence: HoldEvidence };

export interface ToolSetGuardOptions {
  /** The host-confirmed claim; the Tool Set is checked only on hellos it accepts. */
  readonly claim: SlotClaim;
  /** The slot's expected Tool Set; `undefined` for a slot this run does not configure. */
  readonly expected: (slot: SlotRef) => ReadonlyArray<ExpectedTool> | undefined;
  readonly freezer: Pick<SlotFreezer, "freeze">;
  /** Has the host stop a mismatched launch. Not awaited by the hello's refusal. */
  readonly stop: (launchId: string) => Promise<void>;
  readonly onStopFailed?: (launchId: string, cause: unknown) => void;
  /** Defaults to `canonicalSource`. */
  readonly canonical?: (source: string) => string;
}

/** A slot claim that also checks the Tool Set, and lets an unfreeze recheck await a hello. */
export interface ToolSetGuard extends SlotClaim {
  /**
   * Resolves with the check of the next host-accepted hello in `slot`. While it waits, a mismatch
   * is reported to the waiter instead of freezing the slot again (the slot is already frozen and
   * its unfreeze is the one waiting). Returns a function that stops waiting.
   */
  nextHello(slot: SlotRef): { readonly checked: Promise<HelloCheck>; readonly cancel: () => void };
}

const keyOf = (slot: SlotRef): string => JSON.stringify([slot.factoryId, slot.slotId]);

export const createToolSetGuard = (options: ToolSetGuardOptions): ToolSetGuard => {
  const canonical = options.canonical ?? canonicalSource;
  const waiters = new Map<string, (check: HelloCheck) => void>();

  const stop = (launchId: string): void => {
    options.stop(launchId).catch((cause: unknown) => options.onStopFailed?.(launchId, cause));
  };

  return {
    async claim(hello: Hello): Promise<SlotClaimResult> {
      const result = await options.claim.claim(hello);

      if (!result.accepted) {return result;}

      const slot: SlotRef = { factoryId: result.slot.factoryId, slotId: result.slot.slotId };
      const expected = options.expected(slot);

      // Every launch is made from a configured slot, so there is nothing to compare against here.
      if (expected === undefined) {return result;}

      const discrepancy = compareToolSet(expected, hello.tools, canonical);
      const waiter = waiters.get(keyOf(slot));
      waiters.delete(keyOf(slot));

      if (isMatch(discrepancy)) {
        waiter?.({ matched: true, launchId: result.slot.launchId });

        return result;
      }

      const evidence = evidenceOf({ ...hello, launchId: result.slot.launchId }, discrepancy);

      try {
        if (waiter === undefined) {
          await options.freezer.freeze({ ...slot, cause: "tool_set_mismatch", evidence });
        } else {
          waiter({ matched: false, launchId: result.slot.launchId, evidence });
        }
      } finally {
        // Stopped even if the freeze could not be written: a mismatched worker never keeps running.
        stop(result.slot.launchId);
      }

      return { accepted: false, reason: { kind: "terminal", code: TOOL_SET_MISMATCH, detail: describe(discrepancy) } };
    },
    nextHello(slot) {
      const key = keyOf(slot);
      let resolve!: (check: HelloCheck) => void;

      const checked = new Promise<HelloCheck>((r) => {
        resolve = r;
      });

      waiters.set(key, resolve);

      return {
        checked,
        cancel: () => {
          if (waiters.get(key) === resolve) {waiters.delete(key);}
        },
      };
    },
  };
};

/** The conversation a slot frozen for a Tool Set mismatch was in, from its open hold's evidence. */
export const frozenConversation = async (store: Store, slot: SlotRef): Promise<string | undefined> => {
  const holds = await Effect.runPromise(listOpenHolds(store));
  const hold = holds.find((h) => h.factoryId === slot.factoryId && h.kind === "frozen_slot" && h.subject === slot.slotId);

  return hold === undefined ? undefined : Option.getOrUndefined(decodeMismatchEvidence(hold.evidence))?.conversationRef;
};

/** The part of a mismatch hold's evidence a recheck needs. */
const decodeMismatchEvidence = Schema.decodeUnknownOption(Schema.Struct({ conversationRef: Schema.NonEmptyString }));

export interface ToolSetRecheckOptions {
  readonly guard: Pick<ToolSetGuard, "nextHello">;
  readonly conversationOf: (slot: SlotRef) => Promise<string | undefined>;
  /** Starts a new launch in the slot's conversation; rejects while a launch is still live there. */
  readonly relaunch: (slot: SlotRef, conversationRef: string) => Promise<{ readonly launchId: string }>;
  /** Has the host stop a launch whose hello never came. */
  readonly stop: (launchId: string) => Promise<void>;
  /** Defaults to `TOOL_SET_RECHECK_HELLO_TIMEOUT_MS`. */
  readonly helloWithinMs?: number;
}

/**
 * The unfreeze check of `tool_set_mismatch` (PRD §5.3): a new launch in the same conversation,
 * fixed only when its hello matches the Tool Set. A mismatched new launch is stopped by the guard.
 */
export const createToolSetRecheck = (options: ToolSetRecheckOptions): CauseCheck => async (slot) => {
  const conversationRef = await options.conversationOf(slot);

  if (conversationRef === undefined) {
    return { fixed: false, evidence: { recheck: "the hold records no conversation to relaunch; reset the slot instead" } };
  }

  // Registered before the launch, so a fast hello cannot slip past it.
  const waiting = options.guard.nextHello(slot);
  let launchId: string;

  try {
    ({ launchId } = await options.relaunch(slot, conversationRef));
  } catch (cause) {
    waiting.cancel();

    return { fixed: false, evidence: { conversationRef, recheck: `no new launch was started: ${String(cause)}` } };
  }

  const within = options.helloWithinMs ?? TOOL_SET_RECHECK_HELLO_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), within);
  });

  const checked = await Promise.race([waiting.checked, timedOut]);
  clearTimeout(timer);

  if (checked === undefined) {
    waiting.cancel();
    await options.stop(launchId).catch(() => {});

    return { fixed: false, evidence: { launchId, conversationRef, recheck: `the new launch sent no hello within ${within} ms` } };
  }

  return checked.matched ? { fixed: true } : { fixed: false, evidence: checked.evidence };
};
