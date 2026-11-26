/**
 * Operator holds over the management API (PRD §10.2, §11.3): something waiting on the operator
 * that concerns the system's state, not a decision about work. Holds are a record type of their
 * own beside approvals, with at most one open per factory, kind and subject.
 */
import { Schema } from "effect";

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
  "failed_worktree",
] as const;

export const HoldKind = Schema.Literals(HOLD_KINDS);

export type HoldKind = typeof HoldKind.Type;

export const isHoldKind = Schema.is(HoldKind);

/** `resolved` by an operator command on the subject; `cleared` by the daemon when its cause went away. */
export const HoldState = Schema.Literals(["open", "resolved", "cleared"]);

export type HoldState = typeof HoldState.Type;

/** The evidence a hold shows: kind-specific fields, JSON-serialisable. */
export const HoldEvidence = Schema.Record(Schema.String, Schema.Json);

export type HoldEvidence = typeof HoldEvidence.Type;

export const HoldRecord = Schema.Struct({
  id: Schema.Number,
  factoryId: Schema.String,
  kind: HoldKind,
  /** What the hold concerns: a slot (`station/ordinal`), ticket number, message ID or factory. */
  subject: Schema.String,
  state: HoldState,
  evidence: HoldEvidence,
  /** ISO 8601. */
  raisedAt: Schema.String,
  /** ISO 8601 time the evidence was last refreshed. */
  updatedAt: Schema.String,
  /** ISO 8601, or `null` while open. */
  closedAt: Schema.NullOr(Schema.String),
});

export type HoldRecord = typeof HoldRecord.Type;

/** Result of `GET /api/v1/holds`. */
export const HoldListResult = Schema.Struct({
  holds: Schema.Array(HoldRecord),
});

export type HoldListResult = typeof HoldListResult.Type;

/** Result of `GET /api/v1/holds/:id`. */
export const HoldShowResult = Schema.Struct({
  hold: HoldRecord,
  /** The exact commands that act on the subject, the default first (PRD §11.2, §11.3). */
  commands: Schema.Array(Schema.String),
});

export type HoldShowResult = typeof HoldShowResult.Type;

const isNonEmptyText = Schema.is(Schema.NonEmptyString);

const text = (value: Schema.Json | undefined, fallback: string): string => (isNonEmptyText(value) ? value : fallback);

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
    case "failed_worktree":
      // Retry reapplies the recovery rules; discard removes the partial worktree and branch first.
      return [`foundry worktree retry ${s}`, `foundry worktree discard ${s}`, `foundry ticket cancel ${s}`];
    case "stuck_worker": {
      // The subject is the unacknowledged message; the commands act on the slot holding it.
      const slot = text(hold.evidence["slot"], "<station/ordinal>");

      return [`foundry slot interrupt ${slot}`, `foundry slot restart ${slot}`];
    }
  }
};

export const isHoldRecord = Schema.is(HoldRecord);

export const isHoldListResult = Schema.is(HoldListResult);

export const isHoldShowResult = Schema.is(HoldShowResult);
