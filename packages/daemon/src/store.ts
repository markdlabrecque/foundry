/**
 * The Foundry store: the one SQLite database (WAL) per state root, opened only
 * by the daemon (PRD §10.1, ADR 0001).
 *
 * This is the only Foundry module that imports Effect's unstable SQL modules
 * (`effect/sql` and `@effect/sql-sqlite-node`). Everything else goes through
 * the Foundry-owned `Store` interface below.
 *
 * Current-state records are authoritative; history is an append-only log
 * beside them. Every change runs through `Store.change`, which commits the
 * state writes and their history rows in one transaction, or neither.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { expectDefined } from "@foundry/protocol/errors";
import { Clock, Data, Effect } from "effect";
import type { Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError } from "effect/sql";
import type { HistoryRecordRef } from "./history-records.js";

/** Table the migrator records applied migrations in. */
const MIGRATIONS_TABLE = "foundry_migrations";

/** A schema migration: plain SQL statements applied in order, once. */
export interface Migration {
  /** Positive, strictly increasing. The highest applied ID is the schema version. */
  readonly id: number;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/** The migrations this build of Foundry knows, oldest first. */
export const foundryMigrations: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: "history",
    statements: [
      // The sequence number is the per-instance event ID. Times are absolute
      // wall-clock milliseconds since the Unix epoch.
      `CREATE TABLE history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        detail TEXT NOT NULL
      ) STRICT`,
      `CREATE TRIGGER history_no_update BEFORE UPDATE ON history
       BEGIN SELECT RAISE(ABORT, 'history is append-only'); END`,
      `CREATE TRIGGER history_no_delete BEFORE DELETE ON history
       BEGIN SELECT RAISE(ABORT, 'history is append-only'); END`,
    ],
  },
  {
    id: 2,
    name: "operator_hold",
    statements: [
      // Operator holds (PRD §10.2): a record type of their own, separate from approvals. A closed
      // hold is kept; the partial index allows at most one open per factory, kind and subject.
      `CREATE TABLE operator_hold (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'cleared')),
        evidence TEXT NOT NULL,
        raised_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        CHECK ((state = 'open') = (closed_at IS NULL))
      ) STRICT`,
      `CREATE UNIQUE INDEX operator_hold_one_open ON operator_hold (factory_id, kind, subject)
       WHERE state = 'open'`,
    ],
  },
  {
    id: 3,
    name: "tickets",
    statements: [
      // PRD §7.3. The ticket directory holds the specification and evidence; only its path is here.
      `CREATE TABLE ticket (
        factory_id TEXT NOT NULL,
        number INTEGER NOT NULL CHECK (number > 0),
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        production_line TEXT NOT NULL,
        directory TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('backlog', 'stage', 'completed', 'cancelled')),
        stage TEXT,
        status TEXT CHECK (status IS NULL OR status IN ('queued', 'assigned', 'awaiting_approval', 'paused')),
        rejections INTEGER NOT NULL DEFAULT 0,
        rejection_ceiling INTEGER NOT NULL,
        messages_spent INTEGER NOT NULL DEFAULT 0,
        message_ceiling INTEGER NOT NULL,
        worktree_path TEXT,
        branch TEXT,
        start_commit TEXT,
        submitted_at INTEGER NOT NULL,
        PRIMARY KEY (factory_id, number),
        CHECK ((state = 'stage') = (stage IS NOT NULL AND status IS NOT NULL))
      ) STRICT`,
      // PRD §8.2: one row per change to a ticket's stage or status, never updated or deleted.
      `CREATE TABLE ticket_transition (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        from_state TEXT,
        from_stage TEXT,
        from_status TEXT,
        to_state TEXT NOT NULL,
        to_stage TEXT,
        to_status TEXT,
        outcome TEXT,
        reason TEXT,
        git_commit TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        config_load TEXT,
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket (factory_id, number)
      ) STRICT`,
      `CREATE INDEX ticket_transition_by_ticket ON ticket_transition (factory_id, ticket_number, sequence)`,
      `CREATE TRIGGER ticket_transition_no_update BEFORE UPDATE ON ticket_transition
       BEGIN SELECT RAISE(ABORT, 'transitions are append-only'); END`,
      `CREATE TRIGGER ticket_transition_no_delete BEFORE DELETE ON ticket_transition
       BEGIN SELECT RAISE(ABORT, 'transitions are append-only'); END`,
    ],
  },
  {
    id: 4,
    name: "history_records",
    statements: [
      // The records a history row concerns beyond its subject (PRD §15.1), so events can be
      // filtered by ticket, slot and the like. Append-only, like the row it belongs to.
      `CREATE TABLE history_record (
        sequence INTEGER NOT NULL REFERENCES history (sequence),
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        PRIMARY KEY (sequence, record_kind, record_id)
      ) STRICT, WITHOUT ROWID`,
      `CREATE INDEX history_record_by_record ON history_record (record_kind, record_id, sequence)`,
      `CREATE INDEX history_by_factory ON history (factory_id, sequence)`,
      `CREATE TRIGGER history_record_no_update BEFORE UPDATE ON history_record
       BEGIN SELECT RAISE(ABORT, 'history is append-only'); END`,
      `CREATE TRIGGER history_record_no_delete BEFORE DELETE ON history_record
       BEGIN SELECT RAISE(ABORT, 'history is append-only'); END`,
    ],
  },
  {
    id: 5,
    name: "prime",
    statements: [
      // One row per prime the daemon sends (PRD §5.5, §10.1). `parts` is the
      // JSON path-and-hash list; `acknowledged_at` stays NULL until the receipt.
      `CREATE TABLE prime (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        conversation_ref TEXT NOT NULL,
        situation TEXT NOT NULL CHECK (situation IN ('fresh', 'recovery', 'compaction')),
        parts TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      ) STRICT`,
      `CREATE INDEX prime_by_conversation ON prime (factory_id, slot_id, conversation_ref)`,
    ],
  },
  {
    id: 6,
    name: "run_and_config_loads",
    statements: [
      // One run per daemon start (PRD §10.1). `id` is the run ID the daemon log carries.
      `CREATE TABLE run (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        version TEXT NOT NULL
      ) STRICT`,
      // One row per factory per run: the validated configuration and its hash.
      `CREATE TABLE factory_config_load (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES run (id),
        factory_id TEXT NOT NULL,
        yaml_file TEXT NOT NULL,
        config TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        knowledge_root TEXT NOT NULL,
        UNIQUE (run_id, factory_id)
      ) STRICT`,
    ],
  },
  {
    id: 7,
    name: "operation",
    statements: [
      // Operations (PRD §9.4): one record type for integration, sync, worktree creation, hook runs
      // and cleanup. `intent` commits before the action starts; `result` after, with what it causes.
      `CREATE TABLE operation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('integration', 'sync', 'worktree_create', 'hook', 'cleanup')),
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'interrupted', 'complete', 'failed', 'indeterminate')),
        ticket_number INTEGER,
        intent TEXT NOT NULL,
        result TEXT,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        CHECK ((status = 'queued') = (started_at IS NULL)),
        CHECK ((result IS NULL) = (finished_at IS NULL))
      ) STRICT`,
      // The integration and sync queue admits one running entry per factory (PRD §9.4).
      `CREATE UNIQUE INDEX operation_one_running_per_factory ON operation (factory_id)
       WHERE kind IN ('integration', 'sync') AND status = 'running'`,
      `CREATE INDEX operation_queue ON operation (factory_id, status, id)`,
    ],
  },
  {
    id: 8,
    name: "slots_and_launches",
    statements: [
      // PRD §5.2, §10.1: one row per configured slot (`station/ordinal`), with its condition and
      // current launch. Freezing and parking (§5.3) add their causes with their own tickets.
      `CREATE TABLE slot (
        factory_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        station TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        condition TEXT NOT NULL CHECK (condition IN ('normal', 'frozen', 'parked')),
        current_launch TEXT,
        -- A launch requested of the host but not yet recorded: which host process and boot it was
        -- asked of, so a daemon that died mid-request never launches into the slot twice.
        pending_host TEXT,
        pending_boot TEXT,
        PRIMARY KEY (factory_id, slot_id),
        CHECK ((pending_host IS NULL) = (pending_boot IS NULL))
      ) STRICT`,
      // Launch history: the daemon's copy of what the Worker Host reported. The host wins on
      // liveness, the database on everything else.
      `CREATE TABLE launch (
        launch_id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        boot_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('started', 'adopted')),
        ended_at INTEGER,
        end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('exited', 'requested', 'machine_restarted')),
        exit_code INTEGER,
        exit_signal TEXT,
        CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
        FOREIGN KEY (factory_id, slot_id) REFERENCES slot (factory_id, slot_id)
      ) STRICT`,
      `CREATE INDEX launch_by_slot ON launch (factory_id, slot_id, started_at)`,
    ],
  },
  {
    id: 9,
    name: "slot_freeze_cause",
    statements: [
      // PRD §5.3: why a frozen slot is frozen, so unfreeze re-runs the same check. Set only while
      // the slot is frozen; its frozen-slot hold carries the evidence.
      `ALTER TABLE slot ADD COLUMN freeze_cause TEXT CHECK (freeze_cause IS NULL OR freeze_cause IN (
        'host_lost', 'unknown_ownership', 'conversation_changed', 'prime_without_history',
        'instruction_missing', 'tool_set_mismatch'))`,
    ],
  },
  {
    id: 10,
    name: "conversation",
    statements: [
      // PRD §10.1: a slot's conversation, with its opaque reference and a status of current or
      // discarded. It outlives a launch: every launch of the slot opens the current one, so a
      // relaunch after an unexpected end continues it (§10.2). Reset (later) discards it. A slot
      // launched before this migration gets its conversation at its next launch, so that launch
      // starts a new Pi session: acceptable before any release, with no operator state to keep.
      `CREATE TABLE conversation (
        factory_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('current', 'discarded')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (factory_id, slot_id, ref),
        FOREIGN KEY (factory_id, slot_id) REFERENCES slot (factory_id, slot_id)
      ) STRICT`,
      `CREATE UNIQUE INDEX conversation_one_current ON conversation (factory_id, slot_id) WHERE status = 'current'`,
    ],
  },
  {
    id: 11,
    name: "submission",
    statements: [
      // PRD §6.1, §10.1: one row per agent tool call, keyed by the launch the channel was claimed
      // for plus Pi's tool call ID. Written in the transaction that applies the call's effects, with
      // the result returned, so a retry returns `result` and changes nothing.
      `CREATE TABLE submission (
        launch_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        factory_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        result TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY (launch_id, call_id)
      ) STRICT`,
    ],
  },
  {
    id: 12,
    name: "message_acceptance",
    statements: [
      `CREATE TABLE message (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        sender_slot TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        delivery TEXT NOT NULL CHECK (delivery IN ('after_turn', 'when_idle')),
        kind TEXT NOT NULL CHECK (kind IN ('ordinary', 'request_notice', 'delegation_notice', 'reply', 'resume_notice')),
        ticket_number INTEGER,
        request_id TEXT,
        delegation_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('unbound', 'bound', 'sent', 'acknowledged', 'indeterminate', 'dropped', 'expired')),
        accepted_at INTEGER NOT NULL,
        UNIQUE (factory_id, sequence)
      ) STRICT`,
    ],
  },
  {
    id: 13,
    name: "message_binding",
    statements: [
      `ALTER TABLE message ADD COLUMN bound_slot TEXT`,
      `ALTER TABLE message ADD COLUMN bound_at INTEGER`,
      // Binding belongs to the logical slot, never a launch. Delivery/recovery cannot reroute it.
      `CREATE TRIGGER message_binding_immutable BEFORE UPDATE OF bound_slot, bound_at ON message
       WHEN OLD.bound_slot IS NOT NULL AND
         (NEW.bound_slot IS NOT OLD.bound_slot OR NEW.bound_at IS NOT OLD.bound_at)
       BEGIN SELECT RAISE(ABORT, 'message binding is immutable'); END`,
      `CREATE INDEX message_unbound ON message (factory_id, sequence) WHERE status = 'unbound'`,
    ],
  },
  {
    id: 14,
    name: "request_acceptance",
    statements: [
      `CREATE TABLE agent_request (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        requester_slot TEXT NOT NULL,
        recipient TEXT NOT NULL,
        recipient_slot TEXT,
        ticket_number INTEGER,
        notice_id TEXT NOT NULL UNIQUE REFERENCES message(id),
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'failed')),
        accepted_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL CHECK (deadline > accepted_at)
      ) STRICT`,
      `CREATE INDEX agent_request_deadline ON agent_request (deadline) WHERE status = 'open'`,
    ],
  },
  {
    id: 15,
    name: "assignments",
    statements: [
      `CREATE TABLE assignment (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        stage TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'ended')),
        recovery_count INTEGER NOT NULL DEFAULT 0,
        recovery_ceiling INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT,
        context_message TEXT NOT NULL REFERENCES message (id),
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket (factory_id, number),
        FOREIGN KEY (factory_id, slot_id) REFERENCES slot (factory_id, slot_id),
        CHECK ((status = 'ended') = (ended_at IS NOT NULL))
      ) STRICT`,
      `CREATE UNIQUE INDEX assignment_one_unended_ticket ON assignment (factory_id, ticket_number)
       WHERE status != 'ended'`,
      `CREATE UNIQUE INDEX assignment_one_active_slot ON assignment (factory_id, slot_id)
       WHERE status = 'active'`,
    ],
  },
  {
    id: 16,
    name: "message_delivery",
    statements: [
      `ALTER TABLE message ADD COLUMN acknowledged_at INTEGER`,
      `CREATE TABLE message_attempt (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES message(id),
        slot_id TEXT NOT NULL,
        launch_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        UNIQUE (message_id, connection_id)
      ) STRICT`,
    ],
  },
  {
    id: 17,
    name: "operator_message_attribution",
    statements: [
      // Keep request, assignment and delivery-attempt references on the final `message` name.
      // Defer the transient missing parent while rebuilding; validate final integrity below.
      `PRAGMA defer_foreign_keys = ON`,
      `CREATE TABLE message_with_sender (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        sender_kind TEXT NOT NULL DEFAULT 'agent' CHECK (sender_kind IN ('agent', 'operator', 'daemon')),
        sender_slot TEXT,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        delivery TEXT NOT NULL CHECK (delivery IN ('after_turn', 'when_idle')),
        kind TEXT NOT NULL CHECK (kind IN ('ordinary', 'request_notice', 'delegation_notice', 'reply', 'resume_notice')),
        ticket_number INTEGER,
        request_id TEXT,
        delegation_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('unbound', 'bound', 'sent', 'acknowledged', 'indeterminate', 'dropped', 'expired')),
        accepted_at INTEGER NOT NULL,
        bound_slot TEXT,
        bound_at INTEGER,
        acknowledged_at INTEGER,
        CHECK ((sender_kind = 'agent' AND sender_slot IS NOT NULL) OR (sender_kind IN ('operator', 'daemon') AND sender_slot IS NULL)),
        UNIQUE (factory_id, sequence)
      ) STRICT`,
      // Before attribution existed, assignment context used the empty sender slot as daemon.
      `INSERT INTO message_with_sender (id, factory_id, sequence, sender_kind, sender_slot, recipient, body, delivery,
        kind, ticket_number, request_id, delegation_id, status, accepted_at, bound_slot, bound_at, acknowledged_at)
       SELECT id, factory_id, sequence, CASE WHEN sender_slot = '' THEN 'daemon' ELSE 'agent' END,
        NULLIF(sender_slot, ''), recipient, body, delivery,
        kind, ticket_number, request_id, delegation_id, status, accepted_at, bound_slot, bound_at, acknowledged_at FROM message`,
      `DROP TABLE message`,
      `ALTER TABLE message_with_sender RENAME TO message`,
      `CREATE TRIGGER message_binding_immutable BEFORE UPDATE OF bound_slot, bound_at ON message
       WHEN OLD.bound_slot IS NOT NULL AND
         (NEW.bound_slot IS NOT OLD.bound_slot OR NEW.bound_at IS NOT OLD.bound_at)
       BEGIN SELECT RAISE(ABORT, 'message binding is immutable'); END`,
      `CREATE INDEX message_unbound ON message (factory_id, sequence) WHERE status = 'unbound'`,
      // SQLite retains deferred DROP violations even when the parent is restored. Check actual
      // final foreign keys before clearing that transient violation counter, never disable FKs.
      `CREATE TEMP TABLE message_fk_valid (valid INTEGER NOT NULL CHECK (valid = 1))`,
      `INSERT INTO message_fk_valid SELECT 0 FROM pragma_foreign_key_check`,
      `DROP TABLE message_fk_valid`,
      `PRAGMA defer_foreign_keys = OFF`,
    ],
  },
  {
    id: 18,
    name: "delegation_acceptance",
    statements: [
      `CREATE TABLE delegation (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        root_assignment TEXT NOT NULL REFERENCES assignment(id),
        parent_id TEXT REFERENCES delegation(id),
        delegating_slot TEXT NOT NULL,
        recipient TEXT NOT NULL,
        recipient_slot TEXT,
        depth INTEGER NOT NULL CHECK (depth > 0),
        notice_id TEXT NOT NULL UNIQUE REFERENCES message(id),
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'abandoned', 'cancelled')),
        accepted_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX delegation_by_root ON delegation (factory_id, root_assignment, status)`,
    ],
  },
  {
    id: 19,
    name: "idle_slot_recovery",
    statements: [
      `ALTER TABLE slot ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0)`,
    ],
  },
  {
    id: 20,
    name: "assignment_repository_context",
    statements: [
      // Message status/acknowledged_at is the receipt; attribution follows the actual delivery conversation.
      `CREATE TABLE repository_context (
        message_id TEXT PRIMARY KEY REFERENCES message(id),
        assignment_id TEXT NOT NULL REFERENCES assignment(id),
        factory_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        conversation_ref TEXT,
        root TEXT NOT NULL,
        parts TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX repository_context_by_conversation ON repository_context (factory_id, slot_id, conversation_ref)`,
    ],
  },
  {
    id: 21,
    name: "blocked_approvals",
    statements: [
      `CREATE TABLE approval (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES assignment(id),
        transition_sequence INTEGER NOT NULL UNIQUE REFERENCES ticket_transition(sequence),
        kind TEXT NOT NULL CHECK (kind IN ('blocked')),
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        raised_at INTEGER NOT NULL,
        closed_at INTEGER,
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket(factory_id, number),
        CHECK ((state = 'open') = (closed_at IS NULL))
      ) STRICT`,
      `CREATE UNIQUE INDEX approval_one_open_blocked ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'blocked'`,
    ],
  },
  {
    id: 22,
    name: "worker_request_approvals",
    statements: [
      `ALTER TABLE approval RENAME TO approval_old`,
      `CREATE TABLE approval (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES assignment(id),
        transition_sequence INTEGER UNIQUE REFERENCES ticket_transition(sequence),
        kind TEXT NOT NULL CHECK (kind IN ('blocked', 'worker_request')),
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        raised_at INTEGER NOT NULL,
        closed_at INTEGER,
        request_body TEXT,
        request_stage TEXT,
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket(factory_id, number),
        CHECK ((state = 'open') = (closed_at IS NULL)),
        CHECK ((kind = 'blocked' AND transition_sequence IS NOT NULL AND request_body IS NULL AND request_stage IS NULL)
          OR (kind = 'worker_request' AND transition_sequence IS NULL AND request_body IS NOT NULL AND request_stage IS NOT NULL))
      ) STRICT`,
      `INSERT INTO approval (id, factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at, closed_at)
       SELECT id, factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at, closed_at FROM approval_old`,
      `DROP TABLE approval_old`,
      `CREATE UNIQUE INDEX approval_one_open_blocked ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'blocked'`,
    ],
  },
  {
    id: 23,
    name: "message_injection_clock",
    statements: [
      `ALTER TABLE message_attempt ADD COLUMN injected_at INTEGER`,
      `ALTER TABLE message_attempt ADD COLUMN retired_at INTEGER`,
    ],
  },
  {
    id: 24,
    name: "message_limit_approvals",
    statements: [
      `ALTER TABLE approval RENAME TO approval_old`,
      `CREATE TABLE approval (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES assignment(id),
        transition_sequence INTEGER UNIQUE REFERENCES ticket_transition(sequence),
        kind TEXT NOT NULL CHECK (kind IN ('blocked', 'worker_request', 'limit_reached')),
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        raised_at INTEGER NOT NULL,
        closed_at INTEGER,
        request_body TEXT,
        request_stage TEXT,
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket(factory_id, number),
        CHECK ((state = 'open') = (closed_at IS NULL)),
        CHECK ((kind IN ('blocked', 'limit_reached') AND transition_sequence IS NOT NULL AND request_body IS NULL AND request_stage IS NULL)
          OR (kind = 'worker_request' AND transition_sequence IS NULL AND request_body IS NOT NULL AND request_stage IS NOT NULL))
      ) STRICT`,
      `INSERT INTO approval SELECT * FROM approval_old`,
      `DROP TABLE approval_old`,
      `CREATE UNIQUE INDEX approval_one_open_blocked ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'blocked'`,
      `CREATE UNIQUE INDEX approval_one_open_limit ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'limit_reached'`,
    ],
  },
  {
    id: 25,
    name: "stage_gate_approvals",
    statements: [
      `ALTER TABLE approval RENAME TO approval_old`,
      `CREATE TABLE approval (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES assignment(id),
        transition_sequence INTEGER UNIQUE REFERENCES ticket_transition(sequence),
        kind TEXT NOT NULL CHECK (kind IN ('blocked', 'worker_request', 'limit_reached', 'stage_gate')),
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        raised_at INTEGER NOT NULL,
        closed_at INTEGER,
        request_body TEXT,
        request_stage TEXT,
        decision TEXT CHECK (decision IN ('approved', 'rejected')),
        resolution_transition INTEGER UNIQUE REFERENCES ticket_transition(sequence),
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket(factory_id, number),
        CHECK ((state = 'open') = (closed_at IS NULL)),
        CHECK ((kind IN ('blocked', 'limit_reached', 'stage_gate') AND transition_sequence IS NOT NULL AND request_body IS NULL AND request_stage IS NULL)
          OR (kind = 'worker_request' AND transition_sequence IS NULL AND request_body IS NOT NULL AND request_stage IS NOT NULL)),
        CHECK ((kind = 'stage_gate' AND state = 'resolved' AND decision IS NOT NULL AND resolution_transition IS NOT NULL)
          OR (decision IS NULL AND resolution_transition IS NULL AND (kind != 'stage_gate' OR state = 'open')))
      ) STRICT`,
      `INSERT INTO approval (id, factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at, closed_at, request_body, request_stage)
       SELECT id, factory_id, ticket_number, assignment_id, transition_sequence, kind, state, raised_at, closed_at, request_body, request_stage FROM approval_old`,
      `DROP TABLE approval_old`,
      `CREATE UNIQUE INDEX approval_one_open_blocked ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'blocked'`,
      `CREATE UNIQUE INDEX approval_one_open_limit ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'limit_reached'`,
      `CREATE UNIQUE INDEX approval_one_open_gate ON approval(factory_id, ticket_number)
       WHERE state = 'open' AND kind = 'stage_gate'`,
      // Durable handoff only: integration consumes the exact approved commit, never a branch head.
      `CREATE TABLE integration_intent (
        approval_id INTEGER PRIMARY KEY REFERENCES approval(id),
        factory_id TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        approved_commit TEXT NOT NULL,
        transition_sequence INTEGER NOT NULL UNIQUE REFERENCES ticket_transition(sequence),
        requested_at INTEGER NOT NULL,
        FOREIGN KEY (factory_id, ticket_number) REFERENCES ticket(factory_id, number)
      ) STRICT`,
    ],
  },
  {
    id: 26,
    name: "abandoned_requests",
    statements: [
      `CREATE TABLE agent_request_with_abandoned (
        id TEXT PRIMARY KEY,
        factory_id TEXT NOT NULL,
        requester_slot TEXT NOT NULL,
        recipient TEXT NOT NULL,
        recipient_slot TEXT,
        ticket_number INTEGER,
        notice_id TEXT NOT NULL UNIQUE REFERENCES message(id),
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'failed', 'abandoned')),
        accepted_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL CHECK (deadline > accepted_at)
      ) STRICT`,
      `INSERT INTO agent_request_with_abandoned SELECT * FROM agent_request`,
      `DROP TABLE agent_request`,
      `ALTER TABLE agent_request_with_abandoned RENAME TO agent_request`,
      `CREATE INDEX agent_request_deadline ON agent_request (deadline) WHERE status = 'open'`,
    ],
  },
];

/** File name of the database inside the state root. */
export const DATABASE_FILE_NAME = "foundry.db";

/** Values that can be bound to a statement parameter. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type StoreErrorReason =
  /** The database file could not be opened or configured. */
  | "Open"
  /** The database was written by a newer Foundry; the daemon refuses to start. */
  | "NewerSchema"
  /** A known migration failed; nothing from it was kept. */
  | "Migration"
  /** A statement failed. */
  | "Sql"
  /** A change wrote no history row, so it was rolled back. */
  | "NoHistory";

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly reason: StoreErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** One history row, appended beside the current-state writes of a change. */
export interface HistoryEntry {
  readonly factoryId: string;
  /** What happened, e.g. `slot.frozen`. */
  readonly kind: string;
  /** What it happened to, e.g. a slot ID. */
  readonly subject: string;
  /** JSON-serialisable detail. */
  readonly detail?: unknown;
  /**
   * Other records the row concerns, e.g. `{ kind: "ticket", id: "42" }`, so events can be
   * filtered by them. Ticket IDs are their numbers in decimal.
   */
  readonly records?: ReadonlyArray<HistoryRecordRef>;
}

// Record refs live in their own module so readers can use them without loading `node:sqlite`.
export * from "./history-records.js";

/** Runs one statement and returns its rows (empty for writes without `RETURNING`). */
export type Query = <Row extends object = object>(
  statement: string,
  params?: ReadonlyArray<SqlValue>,
) => Effect.Effect<ReadonlyArray<Row>, StoreError>;

/** The handle a change body uses inside its transaction. */
export interface Change {
  readonly query: Query;
  /** Appends a history row in this transaction; returns its sequence number (event ID). */
  readonly recordHistory: (entry: HistoryEntry) => Effect.Effect<number, StoreError>;
}

export interface Store {
  readonly filename: string;
  /** Highest migration ID applied to the database. */
  readonly schemaVersion: number;
  /** Reads outside a change. Writes belong in `change`. */
  readonly read: Query;
  /**
   * Runs `body` in one transaction. Commits its state writes and history rows
   * together only if it succeeds and recorded at least one history row;
   * otherwise rolls all of it back.
   */
  readonly change: <A, E, R>(
    body: (change: Change) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreError, R>;
  /**
   * Calls `listener` after each change commits, so readers can look for new history rows.
   * Returns a function that removes it. A listener that throws is ignored; it never fails the change.
   */
  readonly onCommit: (listener: () => void) => () => void;
}

export interface OpenStoreOptions {
  /** Path to the database file. Its directory must already exist. */
  readonly filename: string;
  /** Defaults to `foundryMigrations`. Overridable so tests can stand in for another build. */
  readonly migrations?: ReadonlyArray<Migration>;
}

const sqlFailure = (reason: StoreErrorReason, message: string) => (cause: unknown) =>
  new StoreError({ reason, message: `${message}: ${describe(cause)}`, cause });

const describe = (cause: unknown): string =>
  SqlError.isSqlError(cause)
    ? describe(cause.reason.cause ?? cause.reason.message)
    : cause instanceof Error
      ? cause.message
      : String(cause);

const makeQuery =
  (sql: SqlClient.SqlClient): Query =>
  <Row extends object = object>(statement: string, params: ReadonlyArray<SqlValue> = []) =>
    sql.unsafe<Row>(statement, params).pipe(Effect.mapError(sqlFailure("Sql", "Statement failed")));

/**
 * Opens the store for the lifetime of the enclosing scope: opens the file in
 * WAL mode, refuses a schema newer than this build knows, then applies any
 * pending migrations in one transaction.
 */
export const openStore = (
  options: OpenStoreOptions,
): Effect.Effect<Store, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const migrations = options.migrations ?? foundryMigrations;
    const known = Math.max(0, ...migrations.map((m) => m.id));

    const sql: SqlClient.SqlClient = yield* SqliteClient.make({ filename: options.filename }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(sqlFailure("Open", `Could not open ${options.filename}`)),
    );

    const query = makeQuery(sql);

    const applied = yield* appliedVersion(query);

    if (applied > known) {
      return yield* new StoreError({
        reason: "NewerSchema",
        message: `${options.filename} has schema version ${applied}, newer than ${known}, the latest this Foundry knows; refusing to open it`,
      });
    }

    yield* SqliteMigrator.run({
      table: MIGRATIONS_TABLE,
      loader: SqliteMigrator.fromRecord(
        Object.fromEntries(
          migrations.map((m) => [
            `${m.id}_${m.name}`,
            Effect.forEach(m.statements, (s) => sql.unsafe(s), { discard: true }),
          ]),
        ),
      ),
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(sqlFailure("Migration", `Could not migrate ${options.filename}`)),
    );

    const commitListeners = new Set<() => void>();

    const change = <A, E, R>(body: (change: Change) => Effect.Effect<A, E, R>): Effect.Effect<A, E | StoreError, R> =>
      Effect.gen(function* () {
        let historyRows = 0;

        const recordHistory = (entry: HistoryEntry) =>
          Effect.gen(function* () {
            const recordedAt = yield* Clock.currentTimeMillis;

            const rows = yield* query<{ sequence: number }>(
              `INSERT INTO history (factory_id, recorded_at, kind, subject, detail)
               VALUES (?, ?, ?, ?, ?) RETURNING sequence`,
              [entry.factoryId, recordedAt, entry.kind, entry.subject, JSON.stringify(entry.detail ?? null)],
            );

            const sequence = expectDefined(rows[0], "the recorded history sequence").sequence;

            for (const record of entry.records ?? []) {
              yield* query(
                `INSERT OR IGNORE INTO history_record (sequence, record_kind, record_id) VALUES (?, ?, ?)`,
                [sequence, record.kind, record.id],
              );
            }

            historyRows += 1;

            return sequence;
          });

        const result = yield* body({ query, recordHistory });

        if (historyRows === 0) {
          return yield* new StoreError({
            reason: "NoHistory",
            message: "A change must record at least one history row; rolled back",
          });
        }

        return result;
      }).pipe(
        sql.withTransaction,
        Effect.mapError((e) => (SqlError.isSqlError(e) ? sqlFailure("Sql", "Transaction failed")(e) : e)),
        Effect.tap(() =>
          Effect.sync(() => {
            // The change has committed. A listener must never turn that into a reported failure,
            // or the caller would think it lost and might retry, writing duplicates (ADR 0001).
            for (const listener of Array.from(commitListeners)) {
              try {
                listener();
              } catch {
                // Ignored: the listener only signals readers; history is already durable.
              }
            }
          }),
        ),
      );

    return {
      filename: options.filename,
      schemaVersion: Math.max(applied, known),
      read: query,
      change,
      onCommit: (listener) => {
        const registered = () => listener();
        commitListeners.add(registered);

        return () => void commitListeners.delete(registered);
      },
    } satisfies Store;
  });

/** Highest migration applied to the file, or 0 for a new database. */
const appliedVersion = (query: Query) =>
  Effect.gen(function* () {
    const tables = yield* query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [MIGRATIONS_TABLE]);

    if (tables.length === 0) {return 0;}

    const rows = yield* query<{ version: number | null }>(
      `SELECT max(migration_id) AS version FROM ${MIGRATIONS_TABLE}`,
    );

    return rows[0]?.version ?? 0;
  });
