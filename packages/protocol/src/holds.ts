/**
 * Operator holds over the management API (PRD §10.2, §11.3): something waiting on the operator
 * that concerns the system's state, not a decision about work. Holds are a record type of their
 * own beside approvals, with at most one open per factory, kind and subject.
 */
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

/** `GET`: the open holds, oldest first (`foundry hold list`). */
export const HOLDS_PATH = `${MANAGEMENT_API_PREFIX}/holds`;

/** `GET`: one hold by ID, open or closed, with the commands that apply (`foundry hold show`). */
export const holdPath = (id: number): string => `${HOLDS_PATH}/${id}`;

/** The hold kinds of PRD §10.2, as stable API codes. */
export const HOLD_KINDS = [
  "frozen_slot",
  "parked_slot",
  "hook_failure",
  "indeterminate_message",
  "indeterminate_integration",
  "interrupted_sync",
  "sync_conflict",
  "stuck_worker",
] as const;

export type HoldKind = (typeof HOLD_KINDS)[number];

export const isHoldKind = (value: unknown): value is HoldKind => (HOLD_KINDS as ReadonlyArray<unknown>).includes(value);

/** `resolved` by an operator command on the subject; `cleared` by the daemon when its cause went away. */
export type HoldState = "open" | "resolved" | "cleared";

/** The evidence a hold shows: kind-specific fields, JSON-serialisable. */
export type HoldEvidence = Readonly<Record<string, unknown>>;

export interface HoldRecord {
  readonly id: number;
  readonly factoryId: string;
  readonly kind: HoldKind;
  /** What the hold concerns: a slot (`station/ordinal`), ticket number, message ID or factory. */
  readonly subject: string;
  readonly state: HoldState;
  readonly evidence: HoldEvidence;
  /** ISO 8601. */
  readonly raisedAt: string;
  /** ISO 8601 time the evidence was last refreshed. */
  readonly updatedAt: string;
  /** ISO 8601, or `null` while open. */
  readonly closedAt: string | null;
}

/** Result of `GET /api/v1/holds`. */
export interface HoldListResult {
  readonly holds: ReadonlyArray<HoldRecord>;
}

/** Result of `GET /api/v1/holds/:id`. */
export interface HoldShowResult {
  readonly hold: HoldRecord;
  /** The exact commands that act on the subject, the default first (PRD §11.2, §11.3). */
  readonly commands: ReadonlyArray<string>;
}

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value : fallback;

/**
 * The commands that resolve a hold (PRD §10.2). Holds have no `resolve` verb; each command acts on
 * the subject. Where the subject alone does not decide it, the evidence does.
 */
export const holdCommands = (hold: Pick<HoldRecord, "kind" | "subject" | "evidence">): ReadonlyArray<string> => {
  const s = hold.subject;

  switch (hold.kind) {
    case "frozen_slot":
      return [`foundry slot unfreeze ${s}`, `foundry slot reset ${s}`];
    case "parked_slot":
      return [`foundry slot reset ${s}`];
    case "hook_failure":
      // `hook` and `operation` name which hook failed and in which operation.
      if (hold.evidence["hook"] === "before_remove") {return [`foundry worktree clean ${s}`];}

      if (hold.evidence["operation"] === "integration") {
        return [`foundry integration retry ${s}`, `foundry ticket cancel ${s}`];
      }

      return [`foundry ticket resume ${s}`, `foundry ticket cancel ${s}`];
    case "indeterminate_message":
      return [`foundry message resend ${s}`, `foundry message drop ${s}`];
    case "indeterminate_integration":
      return [`foundry integration landed ${s}`, `foundry integration not-landed ${s}`];
    case "interrupted_sync":
    case "sync_conflict":
      return [`foundry factory sync ${s}`];
    case "stuck_worker": {
      // The subject is the unacknowledged message; the commands act on the slot holding it.
      const slot = text(hold.evidence["slot"], "<station/ordinal>");

      return [`foundry slot interrupt ${slot}`, `foundry slot restart ${slot}`];
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isHoldRecord = (value: unknown): value is HoldRecord => {
  if (!isRecord(value)) {return false;}

  const { id, factoryId, kind, subject, state, evidence, raisedAt, updatedAt, closedAt } = value;

  return (
    typeof id === "number" &&
    typeof factoryId === "string" &&
    isHoldKind(kind) &&
    typeof subject === "string" &&
    (state === "open" || state === "resolved" || state === "cleared") &&
    isRecord(evidence) &&
    typeof raisedAt === "string" &&
    typeof updatedAt === "string" &&
    (closedAt === null || typeof closedAt === "string")
  );
};

export const isHoldListResult = (value: unknown): value is HoldListResult =>
  isRecord(value) && Array.isArray(value["holds"]) && value["holds"].every(isHoldRecord);

export const isHoldShowResult = (value: unknown): value is HoldShowResult =>
  isRecord(value) &&
  isHoldRecord(value["hold"]) &&
  Array.isArray(value["commands"]) &&
  value["commands"].every((c) => typeof c === "string");
