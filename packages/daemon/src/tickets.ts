/**
 * Tickets in the backlog (PRD §7.3, §8.3): submission, listing and showing.
 *
 * A submitted ticket gets the next per-factory number, a ticket record in the backlog, its first
 * transition and a history row, all in one store change. Its ticket directory, holding `spec.md`
 * and an empty `evidence/`, is written inside that change and removed again if the change does
 * not commit; the database holds only its paths. No worker is needed. Moving tickets out of the
 * backlog belongs to scheduling (21b).
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { expectDefined } from "@foundry/protocol/errors";
import { join } from "node:path";
import { Clock, Data, Effect, Schema } from "effect";
import type {
  SubmitTicketRequest,
  Ticket,
  TicketDetail,
  TicketCancellation,
  TicketListResult,
  TicketPosition,
  TicketState,
  TicketStatus,
  TicketSummary,
  TicketTransition,
} from "@foundry/protocol/tickets-api";
import type { FactoryConfig } from "./config/schema.js";
import { ticketRecord, slotRecord } from "./history-records.js";
import { interruptTicketSlot, retryTicket } from "./ticket-retry.js";
import type { SlotInterrupter } from "./slots-error.js";
import type { Query, Store, StoreError } from "./store.js";
import { closeOpenHoldIn } from "./holds.js";
import { reserveAssignmentSlot } from "./assignment-reservation.js";

/** What submission needs to know about a loaded factory's production line. */
export interface TicketLine {
  readonly rejectionLimit: number;
}

/** What submission needs to know about a loaded factory. */
export interface TicketFactory {
  readonly name: string;
  readonly defaultLine: string;
  readonly lines: Readonly<Record<string, TicketLine>>;
  readonly messageBudget: number;
}

/** Schema defaults (PRD §4); decoding applies them, but the decoded type still marks the keys optional. */
const DEFAULT_REJECTION_LIMIT = 3;
const DEFAULT_MESSAGE_BUDGET = 100;

/** The ticket-relevant part of a validated factory configuration. */
export const ticketFactoryFrom = (config: FactoryConfig): TicketFactory => ({
  name: config.name,
  defaultLine: config.default_production_line,
  messageBudget: config.message_budget ?? DEFAULT_MESSAGE_BUDGET,
  lines: Object.fromEntries(
    Object.entries(config.production_lines).map(([name, line]) => [
      name,
      { rejectionLimit: line.rejection_limit ?? DEFAULT_REJECTION_LIMIT },
    ]),
  ),
});

export type TicketErrorCode =
  | "invalid_request"
  | "factory_required"
  | "unknown_factory"
  | "unknown_line"
  | "ticket_not_found"
  | "invalid_state"
  | "unavailable"
  | "no_live_launch"
  | "channel_unavailable"
  | "interrupt_unacknowledged"
  | "internal";

/** A ticket request refused before anything was written. */
export class TicketError extends Data.TaggedError("TicketError")<{
  readonly code: TicketErrorCode;
  readonly message: string;
}> {}

export const TICKETS_DIR_NAME = "tickets";
export const SPEC_FILE_NAME = "spec.md";
export const EVIDENCE_DIR_NAME = "evidence";

/** A factory name as one safe path segment: no separators, never `.` or `..`. Shared with the factory clone path. */
export const pathSegment = (name: string): string => {
  const encoded = encodeURIComponent(name);

  return encoded === "." || encoded === ".." ? encoded.replaceAll(".", "%2E") : encoded;
};

/**
 * The ticket directory (PRD §8.3): `<state root>/tickets/<factory>/<number>/`. Numbers are per
 * factory, so the factory name keeps two factories' ticket 1 apart.
 */
export const ticketDirectory = (stateRoot: string, factory: string, number: number): string =>
  join(stateRoot, TICKETS_DIR_NAME, pathSegment(factory), String(number));

const SLUG_LIMIT = 48;

/** Lowercase ASCII letters and digits joined by hyphens; `ticket` if nothing is left. */
export const slugify = (title: string): string => {
  const slug = title
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/, "");

  return slug === "" ? "ticket" : slug;
};

export interface TicketService {
  readonly retry: (factory: string | undefined, number: number) => Effect.Effect<TicketDetail, TicketError | StoreError>;
  /** Store-level operator action. Callers must confirm the open work before setting allowAbandon.
   * A queued resume can be reauthorized if its original slot disappears while waiting. */
  readonly resume: (factory: string | undefined, number: number, message?: string, allowAbandon?: boolean) => Effect.Effect<TicketDetail, TicketError | StoreError>;
  readonly inspectCancellation: (factory: string | undefined, number: number) => Effect.Effect<TicketCancellation, TicketError | StoreError>;
  readonly cancel: (factory: string | undefined, number: number, confirmation: string) => Effect.Effect<TicketDetail, TicketError | StoreError>;
  readonly pause: (factory: string | undefined, number: number) => Effect.Effect<TicketDetail, TicketError | StoreError>;
  readonly submit: (request: SubmitTicketRequest) => Effect.Effect<TicketDetail, TicketError | StoreError>;
  /** Without a factory, lists every factory's tickets. Oldest first within each factory. */
  readonly list: (factory: string | undefined) => Effect.Effect<TicketListResult, StoreError>;
  readonly show: (factory: string | undefined, number: number) => Effect.Effect<TicketDetail, TicketError | StoreError>;
}

export interface TicketServiceOptions {
  readonly interrupter?: SlotInterrupter;
  readonly stateRoot: string;
  readonly store: Store;
  /** The factories loaded now; read on every request. */
  readonly factories: () => ReadonlyArray<TicketFactory>;
  /**
   * The recorded configuration load a factory's transitions run under (PRD §8.2), by factory name.
   * Omitted, or returning undefined, leaves a transition's `config_load` null.
   */
  readonly configLoad?: (factory: string) => string | undefined;
}

interface TicketRow {
  factory_id: string;
  number: number;
  title: string;
  slug: string;
  production_line: string;
  directory: string;
  state: TicketState;
  stage: string | null;
  status: TicketStatus | null;
  rejections: number;
  rejection_ceiling: number;
  messages_spent: number;
  message_ceiling: number;
  worktree_path: string | null;
  branch: string | null;
  start_commit: string | null;
  submitted_at: number;
}

interface TransitionRow {
  recorded_at: number;
  actor: string;
  from_state: TicketState | null;
  from_stage: string | null;
  from_status: TicketStatus | null;
  to_state: TicketState;
  to_stage: string | null;
  to_status: TicketStatus | null;
  outcome: string | null;
  reason: string | null;
  git_commit: string | null;
  evidence: string;
  config_load: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const summary = (row: TicketRow): TicketSummary => ({
  factory: row.factory_id,
  number: row.number,
  title: row.title,
  slug: row.slug,
  line: row.production_line,
  state: row.state,
  stage: row.stage,
  status: row.status,
  submittedAt: iso(row.submitted_at),
});

const ticket = (row: TicketRow): Ticket => ({
  ...summary(row),
  directory: row.directory,
  specPath: join(row.directory, SPEC_FILE_NAME),
  evidencePath: join(row.directory, EVIDENCE_DIR_NAME),
  rejections: { spent: row.rejections, ceiling: row.rejection_ceiling },
  messages: { spent: row.messages_spent, ceiling: row.message_ceiling },
  worktree:
    row.worktree_path !== null && row.branch !== null && row.start_commit !== null
      ? { path: row.worktree_path, branch: row.branch, startCommit: row.start_commit }
      : null,
});

const decodeEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const transition = (row: TransitionRow): TicketTransition => ({
  at: iso(row.recorded_at),
  actor: row.actor,
  from: row.from_state === null ? null : { state: row.from_state, stage: row.from_stage, status: row.from_status },
  to: { state: row.to_state, stage: row.to_stage, status: row.to_status },
  outcome: row.outcome,
  reason: row.reason,
  commit: row.git_commit,
  evidence: decodeEvidence(row.evidence),
  configLoad: row.config_load,
});

const refuse = (code: TicketErrorCode, message: string) => Effect.fail(new TicketError({ code, message }));

const BACKLOG: TicketPosition = { state: "backlog", stage: null, status: null };

/** Writes a fresh ticket directory. Anything already there belongs to no committed ticket. */
const materialize = (directory: string, spec: string) =>
  Effect.try({
    try: () => {
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(join(directory, EVIDENCE_DIR_NAME), { recursive: true });
      writeFileSync(join(directory, SPEC_FILE_NAME), spec);
    },
    catch: (cause) =>
      new TicketError({ code: "internal", message: `cannot write ticket directory ${directory}: ${String(cause)}` }),
  });

// The same snapshot is used for disclosure and the transaction's final state check. In
// particular, a newly accepted obligation must never be silently cancelled after confirmation.
const cancellationSnapshot = (query: Query, factory: string, number: number) => Effect.gen(function* () {
  const [row] = yield* query<TicketRow>(`SELECT * FROM ticket WHERE factory_id = ? AND number = ?`, [factory, number]);

  if (row === undefined) {return yield* refuse("ticket_not_found", `No ticket ${number} in factory "${factory}"`);}

  if (row.state === "completed" || row.state === "cancelled") {
    return yield* refuse("invalid_state", "Only an unfinished ticket can be cancelled");
  }

  const assignments = yield* query<{ id: string; slot_id: string; status: string }>(
    `SELECT id, slot_id, status FROM assignment WHERE factory_id = ? AND ticket_number = ? AND status != 'ended'`, [factory, number]);

  const requests = yield* query<{ id: string }>(
    `SELECT id FROM agent_request WHERE factory_id = ? AND ticket_number = ? AND status = 'open' ORDER BY id`, [factory, number]);

  const delegations = yield* query<{ id: string }>(
    `SELECT d.id FROM delegation d JOIN assignment a ON a.id = d.root_assignment
     WHERE d.factory_id = ? AND a.ticket_number = ? AND a.factory_id = ? AND d.status = 'open' ORDER BY d.id`, [factory, number, factory]);

  const confirmation = createHash("sha256").update(JSON.stringify({ row, assignments, requests, delegations })).digest("hex");

  return { row, assignments, disclosure: { factory, number, requests: requests.map((r) => r.id),
    delegations: delegations.map((d) => d.id), worktree: row.worktree_path, confirmation } };
});

export const createTicketService = (options: TicketServiceOptions): TicketService => {
  const { store, stateRoot } = options;

  /** The named factory, or the only one loaded when none is named (PRD §11.1). */
  const loadedFactory = (name: string | undefined) => {
    const loaded = options.factories();

    if (name !== undefined) {
      const found = loaded.find((f) => f.name === name);

      return found === undefined ? refuse("unknown_factory", `No factory "${name}" is loaded`) : Effect.succeed(found);
    }

    const [only] = loaded;

    if (loaded.length === 1 && only !== undefined) {return Effect.succeed(only);}

    return refuse(
      "factory_required",
      loaded.length === 0 ? "No factory is loaded" : "More than one factory is loaded; name one with --factory",
    );
  };

  const show: TicketService["show"] = (name, number) =>
    Effect.gen(function* () {
      const factory = name ?? (yield* loadedFactory(undefined)).name;

      const rows = yield* store.read<TicketRow>(`SELECT * FROM ticket WHERE factory_id = ? AND number = ?`, [
        factory,
        number,
      ]);

      const row = rows[0];

      if (row === undefined) {return yield* refuse("ticket_not_found", `No ticket ${number} in factory "${factory}"`);}

      const transitions = yield* store.read<TransitionRow>(
        `SELECT * FROM ticket_transition WHERE factory_id = ? AND ticket_number = ? ORDER BY sequence`,
        [factory, number],
      );

      return { ticket: ticket(row), transitions: transitions.map(transition) };
    });

  // A duplicate action must not retain a stale assignment and later interrupt its successor.
  // Reserve the ticket before the first read, through acknowledgement and durable suspension.
  const acting = new Set<string>();

  const act = (name: string | undefined, number: number, action: (factory: string, number: number) => Effect.Effect<TicketDetail, TicketError | StoreError>) => Effect.gen(function* () {
    const factory = (yield* loadedFactory(name)).name;
    const key = JSON.stringify([factory, number]);

    return yield* Effect.suspend(() => {
      if (acting.has(key)) {return refuse("invalid_state", "A ticket action is already in progress");}

      acting.add(key);

      return action(factory, number).pipe(Effect.ensuring(Effect.sync(() => { acting.delete(key); })));
    }).pipe(Effect.uninterruptible);
  });

  // Keep capacity reserved until the authenticated worker acknowledges settlement. Do not hold
  // a database transaction across channel I/O; recheck the assignment identity before committing.
  const pauseAssigned = (factory: string, number: number) => Effect.gen(function* () {
    const current = yield* show(factory, number);

    if (current.ticket.state !== "stage" || current.ticket.status !== "assigned") {
      return yield* refuse("invalid_state", "Only an assigned ticket can be paused");
    }

    const [assignment] = yield* store.read<{ id: string; slot_id: string }>(
      `SELECT id, slot_id FROM assignment WHERE factory_id = ? AND ticket_number = ? AND status = 'active'`,
      [factory, number],
    );

    if (assignment === undefined) {return yield* refuse("invalid_state", "The ticket has no active assignment");}

    yield* interruptTicketSlot(options.interrupter, factory, assignment.slot_id);
    yield* store.change((change) => Effect.gen(function* () {
      const rows = yield* change.query<{ stage: string }>(
        `SELECT t.stage FROM ticket t JOIN assignment a ON a.factory_id = t.factory_id AND a.ticket_number = t.number
         WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage' AND t.status = 'assigned'
         AND a.id = ? AND a.status = 'active' AND a.stage = t.stage`,
        [factory, number, assignment.id],
      );

      const row = rows[0];

      if (row === undefined) {return yield* refuse("invalid_state", "The assignment changed while the worker was interrupted");}

      const now = yield* Clock.currentTimeMillis;
      yield* change.query(`UPDATE assignment SET status = 'suspended' WHERE id = ?`, [assignment.id]);
      yield* change.query(`UPDATE ticket SET status = 'paused' WHERE factory_id = ? AND number = ?`, [factory, number]);
      yield* change.query(
        `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
          from_state, from_stage, from_status, to_state, to_stage, to_status, config_load)
         VALUES (?, ?, ?, 'operator', 'stage', ?, 'assigned', 'stage', ?, 'paused', ?)`,
        [factory, number, now, row.stage, row.stage, options.configLoad?.(factory) ?? null],
      );
      yield* change.recordHistory({ factoryId: factory, kind: "ticket.paused", subject: String(number),
        detail: { assignment: assignment.id, slotId: assignment.slot_id },
        records: [ticketRecord(number), slotRecord(assignment.slot_id)],
      });
    }));

    return yield* show(factory, number);
  });

  const pause: TicketService["pause"] = (name, number) => act(name, number, pauseAssigned);

  const retry: TicketService["retry"] = (name, number) => act(name, number, (factory, ticketNumber) =>
    show(factory, ticketNumber).pipe(Effect.flatMap(() => retryTicket(options, factory, ticketNumber)),
      Effect.flatMap(() => show(factory, ticketNumber))));

  const inspectCancellation: TicketService["inspectCancellation"] = (name, number) => Effect.gen(function* () {
    const factory = (yield* loadedFactory(name)).name;

    return (yield* cancellationSnapshot(store.read, factory, number)).disclosure;
  });

  const cancel: TicketService["cancel"] = (name, number, confirmation) => Effect.gen(function* () {
    const factory = (yield* loadedFactory(name)).name;
    const key = JSON.stringify([factory, number]);

    return yield* Effect.suspend(() => {
      if (acting.has(key)) {return refuse("invalid_state", "An operator action is already in progress for this ticket");}

      acting.add(key);

      return cancelTicket(factory, number, confirmation).pipe(Effect.ensuring(Effect.sync(() => { acting.delete(key); })));
    }).pipe(Effect.uninterruptible);
  });

  const cancelTicket = (factory: string, number: number, confirmation: string) => Effect.suspend(() => {
    let release: (() => void) | undefined;

    return Effect.gen(function* () {
    const before = yield* cancellationSnapshot(store.read, factory, number);

    if (before.disclosure.confirmation !== confirmation) {return yield* refuse("invalid_state", "Ticket changed; inspect and confirm cancellation again");}

    const active = before.assignments.find((a) => a.status === "active");

    if (active !== undefined) {
      // Serialize acquisition with the scheduler's writer transaction. This read-only change
      // deliberately rolls back: the only reservation is process-local, not a durable action.
      const reserved = Symbol("slot reserved");
      yield* store.change((change) => Effect.gen(function* () {
        const current = yield* cancellationSnapshot(change.query, factory, number);

        if (current.disclosure.confirmation !== confirmation) {return yield* refuse("invalid_state", "Assignment changed before interruption; confirm again");}

        release = reserveAssignmentSlot(store, factory, active.slot_id);

        if (release === undefined) {return yield* refuse("invalid_state", "The assignment's slot is already reserved");}

        return yield* Effect.fail(reserved);
      })).pipe(Effect.catchIf((error) => error === reserved, () => Effect.void));
      yield* interruptTicketSlot(options.interrupter, factory, active.slot_id);
    }

    yield* store.change((change) => Effect.gen(function* () {
      const current = yield* cancellationSnapshot(change.query, factory, number);

      if (current.disclosure.confirmation !== confirmation) {return yield* refuse("invalid_state", "Ticket changed while the worker was interrupted; confirm again");}

      const now = yield* Clock.currentTimeMillis;
      yield* change.query(`UPDATE assignment SET status = 'ended', ended_at = ?, end_reason = 'cancelled'
        WHERE factory_id = ? AND ticket_number = ? AND status != 'ended'`, [now, factory, number]);
      yield* change.query(`UPDATE delegation SET status = 'cancelled' WHERE factory_id = ? AND status = 'open'
        AND root_assignment IN (SELECT id FROM assignment WHERE factory_id = ? AND ticket_number = ?)`, [factory, factory, number]);
      yield* change.query(`UPDATE agent_request SET status = 'cancelled' WHERE factory_id = ? AND ticket_number = ? AND status = 'open'`, [factory, number]);
      // Never retract an attempted copy or alter its receipts. Unattempted ticket context and
      // obligation notices must not start stale work after the assignment releases capacity.
      yield* change.query(`UPDATE message SET status = 'dropped' WHERE factory_id = ? AND ticket_number = ?
        AND status IN ('unbound', 'bound') AND NOT EXISTS (SELECT 1 FROM message_attempt WHERE message_id = message.id)`, [factory, number]);
      yield* closeOpenHoldIn(change, { factoryId: factory, kind: "hook_failure", subject: String(number) }, "resolved");
      yield* change.query(`UPDATE ticket SET state = 'cancelled', stage = NULL, status = NULL WHERE factory_id = ? AND number = ?`, [factory, number]);

      const transitions = yield* change.query<{ sequence: number }>(`INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
        from_state, from_stage, from_status, to_state, config_load)
        VALUES (?, ?, ?, 'operator', ?, ?, ?, 'cancelled', ?) RETURNING sequence`,
      [factory, number, now, current.row.state, current.row.stage, current.row.status, options.configLoad?.(factory) ?? null]);

      const transition = expectDefined(transitions[0], "the cancellation transition").sequence;
      yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = ?,
        resolution_transition = CASE WHEN kind = 'stage_gate' THEN ? ELSE resolution_transition END
        WHERE factory_id = ? AND ticket_number = ? AND state = 'open'`, [now, transition, factory, number]);
      yield* change.recordHistory({ factoryId: factory, kind: "ticket.transitioned", subject: String(number),
        detail: { from: { state: current.row.state, stage: current.row.stage, status: current.row.status },
          to: { state: "cancelled", stage: null, status: null }, outcome: null, actor: "operator", reason: null,
          assignments: current.assignments.map((a) => a.id), requests: current.disclosure.requests,
          delegations: current.disclosure.delegations, worktreeKept: current.row.worktree_path },
        records: [ticketRecord(number), ...current.assignments.map((a) => slotRecord(a.slot_id))] });
    }));

    return yield* show(factory, number);
    }).pipe(Effect.ensuring(Effect.sync(() => { release?.(); })));
  });

  const submit: TicketService["submit"] = (request) =>
    Effect.gen(function* () {
      const factory = yield* loadedFactory(request.factory);
      const title = request.title.trim();

      if (title === "" || /[\r\n]/.test(title)) {
        return yield* refuse("invalid_request", "A ticket title must be one non-empty line");
      }

      const lineName = request.line ?? factory.defaultLine;

      const line = Object.hasOwn(factory.lines, lineName) ? factory.lines[lineName] : undefined;

      if (line === undefined) {
        const known = Object.keys(factory.lines).join(", ");

        return yield* refuse(
          "unknown_line",
          `No production line "${lineName}" in factory "${factory.name}"; its lines are: ${known}`,
        );
      }

      const submittedAt = yield* Clock.currentTimeMillis;

      let written: string | undefined;

      const number = yield* store
        .change(({ query, recordHistory }) =>
          Effect.gen(function* () {
            const next = yield* query<{ next: number }>(
              `SELECT coalesce(max(number), 0) + 1 AS next FROM ticket WHERE factory_id = ?`,
              [factory.name],
            );

            const number = expectDefined(next[0], "the next ticket number").next;
            const directory = ticketDirectory(stateRoot, factory.name, number);
            yield* query(
              `INSERT INTO ticket (factory_id, number, title, slug, production_line, directory, state,
                 rejection_ceiling, message_ceiling, submitted_at)
               VALUES (?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?)`,
              [
                factory.name,
                number,
                title,
                slugify(title),
                lineName,
                directory,
                line.rejectionLimit,
                factory.messageBudget,
                submittedAt,
              ],
            );
            yield* query(
              `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, to_state, config_load)
               VALUES (?, ?, ?, 'operator', ?, ?)`,
              [factory.name, number, submittedAt, BACKLOG.state, options.configLoad?.(factory.name) ?? null],
            );
            yield* recordHistory({
              factoryId: factory.name,
              kind: "ticket.submitted",
              subject: String(number),
              records: [ticketRecord(number)],
              detail: { title, line: lineName, directory },
            });
            // Last, so a failed statement never leaves files; a failed commit removes them below.
            written = directory;
            yield* materialize(directory, request.spec);

            return number;
          }),
        )
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (written !== undefined) {rmSync(written, { recursive: true, force: true });}
            }),
          ),
        );

      return yield* show(factory.name, number);
    });

  const list: TicketService["list"] = (factory) =>
    Effect.map(
      factory === undefined
        ? store.read<TicketRow>(`SELECT * FROM ticket ORDER BY factory_id, number`)
        : store.read<TicketRow>(`SELECT * FROM ticket WHERE factory_id = ? ORDER BY number`, [factory]),
      (rows) => ({ tickets: rows.map(summary) }),
    );

  const resume: TicketService["resume"] = (name, number, message, allowAbandon = false) => Effect.gen(function* () {
    const factory = (yield* loadedFactory(name)).name;
    yield* store.change((change) => Effect.gen(function* () {
      const [row] = yield* change.query<{ id: string; stage: string; status: string }>(
        `SELECT a.id, t.stage, t.status FROM ticket t JOIN assignment a ON a.factory_id = t.factory_id AND a.ticket_number = t.number
         WHERE t.factory_id = ? AND t.number = ? AND t.state = 'stage'
         AND (t.status = 'paused' OR (t.status = 'queued' AND EXISTS (SELECT 1 FROM assignment_resume r WHERE r.assignment_id = a.id)))
         AND a.status = 'suspended' AND a.stage = t.stage`, [factory, number],
      );

      if (row === undefined) {return yield* refuse("invalid_state", "Resume requires a paused ticket with a suspended assignment");}

      if (row.status === 'queued' && !allowAbandon) {return yield* refuse("invalid_state", "The ticket is already queued for resume");}

      const limit = yield* change.query(`SELECT id FROM approval WHERE factory_id = ? AND ticket_number = ? AND kind = 'limit_reached' AND state = 'open'`, [factory, number]);

      if (limit.length > 0) {return yield* refuse("invalid_state", "Resuming a limit-reached ticket requires an allowance grant");}

      const now = yield* Clock.currentTimeMillis;
      yield* change.query(`INSERT INTO assignment_resume (assignment_id, operator_message, allow_abandon) VALUES (?, ?, ?)
        ON CONFLICT(assignment_id) DO UPDATE SET operator_message = excluded.operator_message, allow_abandon = excluded.allow_abandon`, [row.id, message ?? null, allowAbandon ? 1 : 0]);
      yield* change.query(`UPDATE ticket SET status = 'queued' WHERE factory_id = ? AND number = ?`, [factory, number]);
      yield* change.query(`UPDATE approval SET state = 'resolved', closed_at = ? WHERE factory_id = ? AND ticket_number = ? AND state = 'open' AND kind = 'blocked'`, [now, factory, number]);

      if (row.status === 'paused') {
        yield* change.query(
          `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
            from_state, from_stage, from_status, to_state, to_stage, to_status, config_load)
           VALUES (?, ?, ?, 'operator', 'stage', ?, 'paused', 'stage', ?, 'queued', ?)`,
          [factory, number, now, row.stage, row.stage, options.configLoad?.(factory) ?? null],
        );
      }

      yield* change.recordHistory({ factoryId: factory, kind: "ticket.resumed", subject: String(number),
        detail: { assignment: row.id, message: message ?? null }, records: [ticketRecord(number)] });
    }));

    return yield* show(factory, number);
  });

  return { submit, list, show, pause, resume, retry, inspectCancellation, cancel };
};
