/**
 * The ticket routes of the management API (PRD §7.3, §8.3, §11.1): submit, list and show.
 * Responses use the envelope of `./management-api.ts`.
 *
 * - `POST /api/v1/tickets` with a `SubmitTicketRequest` body: `201` with a `TicketDetail`.
 * - `GET /api/v1/tickets[?factory=<name>]`: a `TicketListResult`.
 * - `GET /api/v1/tickets/<n>[?factory=<name>]`: a `TicketDetail`.
 * - `POST /api/v1/tickets/<n>/pause[?factory=<name>]`: a `TicketDetail`, after worker settlement.
 * - `GET /api/v1/tickets/<n>/cancel[?factory=<name>]`: a `TicketCancellation` disclosure.
 * - `POST /api/v1/tickets/<n>/cancel[?factory=<name>]` with `{ confirmation }`: a `TicketDetail`.
 *
 * `factory` may be left out only when exactly one factory is loaded (PRD §11.1); listing without
 * it lists every factory's tickets.
 */
import { Schema } from "effect";

import { MANAGEMENT_API_PREFIX } from "./management-api.js";

export const TICKETS_PATH = `${MANAGEMENT_API_PREFIX}/tickets`;

/** Path of one ticket, addressed by its per-factory number. */
export const ticketPath = (number: number): string => `${TICKETS_PATH}/${number}`;

/** Query parameter naming the factory. */
export const FACTORY_PARAM = "factory";

/** Body of `POST /api/v1/tickets`. The CLI sends the submitted file's text; the daemon copies it. */
export interface SubmitTicketRequest {
  readonly factory?: string;
  readonly title: string;
  /** Production line; the factory default when left out. */
  readonly line?: string;
  /** Text of the submitted specification, written unchanged to the ticket directory's `spec.md`. */
  readonly spec: string;
}

/** Where a ticket is (PRD §8.2): in the backlog, at a stage, completed or cancelled. */
export const TicketState = Schema.Literals(["backlog", "stage", "completed", "cancelled"]);

export type TicketState = typeof TicketState.Type;

/** A ticket's status at a stage; null outside a stage. */
export const TicketStatus = Schema.Literals(["queued", "assigned", "awaiting_approval", "paused"]);

export type TicketStatus = typeof TicketStatus.Type;

const positionFields = {
  state: TicketState,
  stage: Schema.NullOr(Schema.String),
  status: Schema.NullOr(TicketStatus),
};

export const TicketPosition = Schema.Struct(positionFields);

export type TicketPosition = typeof TicketPosition.Type;

const summaryFields = {
  ...positionFields,
  factory: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  slug: Schema.String,
  line: Schema.String,
  /** ISO 8601. */
  submittedAt: Schema.String,
};

export const TicketSummary = Schema.Struct(summaryFields);

export type TicketSummary = typeof TicketSummary.Type;

export const TicketCounter = Schema.Struct({
  spent: Schema.Number,
  ceiling: Schema.Number,
});

export type TicketCounter = typeof TicketCounter.Type;

export const Ticket = Schema.Struct({
  ...summaryFields,
  /** The ticket directory (PRD §8.3), holding `spec.md` and `evidence/`. */
  directory: Schema.String,
  specPath: Schema.String,
  evidencePath: Schema.String,
  rejections: TicketCounter,
  messages: TicketCounter,
  /** Recorded when the worktree is created; null until then. */
  worktree: Schema.NullOr(
    Schema.Struct({ path: Schema.String, branch: Schema.String, startCommit: Schema.String }),
  ),
});

export type Ticket = typeof Ticket.Type;

/** One change to a ticket's stage or status (PRD §8.2). `from` is null for submission. */
export const TicketTransition = Schema.Struct({
  /** ISO 8601. */
  at: Schema.String,
  actor: Schema.String,
  from: Schema.NullOr(TicketPosition),
  to: TicketPosition,
  outcome: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  evidence: Schema.Array(Schema.String),
  configLoad: Schema.NullOr(Schema.String),
});

export type TicketTransition = typeof TicketTransition.Type;

/** Result of submit and show. */
export const TicketDetail = Schema.Struct({
  ticket: Ticket,
  transitions: Schema.Array(TicketTransition),
});

export type TicketDetail = typeof TicketDetail.Type;

/** Result of list. */
export const TicketListResult = Schema.Struct({
  tickets: Schema.Array(TicketSummary),
});

export type TicketListResult = typeof TicketListResult.Type;

export const isTicketListResult = Schema.is(TicketListResult);

export const isTicketDetail = Schema.is(TicketDetail);

/** Exact open obligations disclosed before operator cancellation; artifacts are never removed. */
export const TicketCancellation = Schema.Struct({
  factory: Schema.String,
  number: Schema.Number,
  requests: Schema.Array(Schema.String),
  delegations: Schema.Array(Schema.String),
  worktree: Schema.NullOr(Schema.String),
  confirmation: Schema.String,
});

export type TicketCancellation = typeof TicketCancellation.Type;

export const isTicketCancellation = Schema.is(TicketCancellation);
