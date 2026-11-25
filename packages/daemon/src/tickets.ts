/**
 * Tickets in the backlog (PRD §7.3, §8.3): submission, listing and showing.
 *
 * A submitted ticket gets the next per-factory number, a ticket record in the backlog, its first
 * transition and a history row, all in one store change. Its ticket directory, holding `spec.md`
 * and an empty `evidence/`, is written inside that change and removed again if the change does
 * not commit; the database holds only its paths. No worker is needed. Moving tickets out of the
 * backlog belongs to scheduling (21b).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { expectDefined } from "@foundry/protocol/errors";
import { join } from "node:path";
import { Clock, Data, Effect, Schema } from "effect";
import type {
  SubmitTicketRequest,
  Ticket,
  TicketDetail,
  TicketListResult,
  TicketPosition,
  TicketState,
  TicketStatus,
  TicketSummary,
  TicketTransition,
} from "@foundry/protocol/tickets-api";
import type { FactoryConfig } from "./config/schema.js";
import { ticketRecord } from "./history-records.js";
import type { Store, StoreError } from "./store.js";

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
  readonly submit: (request: SubmitTicketRequest) => Effect.Effect<TicketDetail, TicketError | StoreError>;
  /** Without a factory, lists every factory's tickets. Oldest first within each factory. */
  readonly list: (factory: string | undefined) => Effect.Effect<TicketListResult, StoreError>;
  readonly show: (factory: string | undefined, number: number) => Effect.Effect<TicketDetail, TicketError | StoreError>;
}

export interface TicketServiceOptions {
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

export const makeTicketService = (options: TicketServiceOptions): TicketService => {
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

  return { submit, list, show };
};
