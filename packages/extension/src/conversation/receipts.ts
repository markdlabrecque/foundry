/**
 * The receipt rule shared by primes and messages (PRD §5.5, §6.3): the
 * extension issues a receipt for a Foundry ID only once that ID is in the
 * worker's recoverable conversation history. Arrival at the socket, an
 * in-memory enqueue, an injection and the start of a turn do not qualify.
 */
import { readFileSync } from "node:fs";
import { codeOf } from "@foundry/protocol/errors";

/** The `customType` every Foundry injection carries in Pi's session. */
export const FOUNDRY_MESSAGE_TYPE = "foundry" as const;

export type InjectionKind = "prime" | "message";

/** Stored in the session entry's `details`, so the ID can be found in history later. */
export interface FoundryMessageDetails {
  readonly foundryId: string;
  readonly kind: InjectionKind;
}

/** Something Foundry injects into the conversation under a known ID. */
export interface FoundryInjection {
  readonly id: string;
  readonly kind: InjectionKind;
  readonly content: string;
}

/** Which of the given IDs are in the worker's recoverable conversation history. */
export interface RecoverableHistory {
  recoverable(ids: ReadonlyArray<string>): ReadonlySet<string>;
}

/**
 * Tracks the IDs this extension injected and issues each one's receipt once,
 * at the first check that finds it in recoverable history.
 */
export class ReceiptIssuer {
  private readonly awaiting = new Set<string>();

  constructor(
    private readonly history: RecoverableHistory,
    private readonly onReceipt: (id: string) => void,
  ) {}

  /** Start waiting for `id` to become recoverable. */
  expect(id: string): void {
    this.awaiting.add(id);
  }

  /** IDs injected but not yet found in recoverable history. */
  pending(): ReadonlyArray<string> {
    return [...this.awaiting];
  }

  /** Issue receipts for every awaited ID now in recoverable history; returns them. */
  check(): ReadonlyArray<string> {
    if (this.awaiting.size === 0) {return [];}

    const found = this.history.recoverable([...this.awaiting]);
    const issued = [...this.awaiting].filter((id) => found.has(id));

    for (const id of issued) {
      this.awaiting.delete(id);
      this.onReceipt(id);
    }

    return issued;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Foundry IDs in a Pi session file on disk. Pi rebuilds a relaunched worker's
 * conversation from this file only; entries it still holds in memory (a fresh
 * session is not written until it has a user or assistant message) are not
 * recoverable. A missing file holds nothing.
 */
export const readRecoverableIds = (sessionFile: string | undefined): Set<string> => {
  const ids = new Set<string>();

  if (sessionFile === undefined) {return ids;}

  let text: string;

  try {
    text = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") {return ids;}

    throw error;
  }

  for (const line of text.split("\n")) {
    if (line.trim() === "") {continue;}

    let entry: unknown;

    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Pi skips malformed lines when it restores, so they are not recoverable.
    }

    if (!isRecord(entry) || entry["type"] !== "custom_message" || entry["customType"] !== FOUNDRY_MESSAGE_TYPE) {continue;}

    const details = entry["details"];

    if (isRecord(details) && typeof details["foundryId"] === "string") {ids.add(details["foundryId"]);}
  }

  return ids;
};

/** Recoverable history read from whichever session file the worker currently writes. */
export const sessionFileHistory = (sessionFile: () => string | undefined): RecoverableHistory => ({
  recoverable(ids) {
    const present = readRecoverableIds(sessionFile());

    return new Set(ids.filter((id) => present.has(id)));
  },
});
