/**
 * The ticket routes of the management API (PRD §7.3, §8.3, §11.1): submit, list and show.
 * Responses use the envelope of `./management-api.ts`.
 *
 * - `POST /api/v1/tickets` with a `SubmitTicketRequest` body: `201` with a `TicketDetail`.
 * - `GET /api/v1/tickets[?factory=<name>]`: a `TicketListResult`.
 * - `GET /api/v1/tickets/<n>[?factory=<name>]`: a `TicketDetail`.
 *
 * `factory` may be left out only when exactly one factory is loaded (PRD §11.1); listing without
 * it lists every factory's tickets.
 */
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
export type TicketState = "backlog" | "stage" | "completed" | "cancelled";

/** A ticket's status at a stage; null outside a stage. */
export type TicketStatus = "queued" | "assigned" | "awaiting_approval" | "paused";

export interface TicketPosition {
  readonly state: TicketState;
  readonly stage: string | null;
  readonly status: TicketStatus | null;
}

export interface TicketSummary extends TicketPosition {
  readonly factory: string;
  readonly number: number;
  readonly title: string;
  readonly slug: string;
  readonly line: string;
  /** ISO 8601. */
  readonly submittedAt: string;
}

export interface TicketCounter {
  readonly spent: number;
  readonly ceiling: number;
}

export interface Ticket extends TicketSummary {
  /** The ticket directory (PRD §8.3), holding `spec.md` and `evidence/`. */
  readonly directory: string;
  readonly specPath: string;
  readonly evidencePath: string;
  readonly rejections: TicketCounter;
  readonly messages: TicketCounter;
  /** Recorded when the worktree is created; null until then. */
  readonly worktree: { readonly path: string; readonly branch: string; readonly startCommit: string } | null;
}

/** One change to a ticket's stage or status (PRD §8.2). `from` is null for submission. */
export interface TicketTransition {
  /** ISO 8601. */
  readonly at: string;
  readonly actor: string;
  readonly from: TicketPosition | null;
  readonly to: TicketPosition;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly commit: string | null;
  readonly evidence: ReadonlyArray<string>;
  readonly configLoad: string | null;
}

/** Result of submit and show. */
export interface TicketDetail {
  readonly ticket: Ticket;
  readonly transitions: ReadonlyArray<TicketTransition>;
}

/** Result of list. */
export interface TicketListResult {
  readonly tickets: ReadonlyArray<TicketSummary>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSummary = (value: unknown): value is TicketSummary =>
  isRecord(value) &&
  typeof value["factory"] === "string" &&
  typeof value["number"] === "number" &&
  typeof value["title"] === "string" &&
  typeof value["line"] === "string" &&
  typeof value["state"] === "string";

export const isTicketListResult = (value: unknown): value is TicketListResult =>
  isRecord(value) && Array.isArray(value["tickets"]) && value["tickets"].every(isSummary);

export const isTicketDetail = (value: unknown): value is TicketDetail => {
  if (!isRecord(value) || !Array.isArray(value["transitions"])) {return false;}

  const ticket = value["ticket"];

  return isSummary(ticket) && isRecord(ticket) && typeof ticket["directory"] === "string";
};
