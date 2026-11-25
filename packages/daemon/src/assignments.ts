/** Committed-state assignment step (PRD §8.2, §10.1), independent of outcome handlers. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Cause, Clock, Data, Effect, Exit } from "effect";
import { acceptMessage } from "./agent-message.js";
import { abandonAssignment } from "./assignment-abandon.js";
import { composeResumeNotice } from "./resume-notice.js";
import { voidStaleApprovals } from "./approval-voiding.js";
import { isAssignmentSlotReserved, onAssignmentSlotReleased } from "./assignment-reservation.js";
import { eligibleAssignmentSlots } from "./assignment-slots.js";
import { composeAssignmentRepositoryContext, recordAssignmentRepositoryContext } from "./assignment-repository-context.js";
import type { AssignmentSlot } from "./assignment-slots.js";
import type { FactoryConfig } from "./config/schema.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import type { PlannedSlot } from "./slots.js";
import type { Change, Query, Store, StoreError } from "./store.js";

export interface Assignment {
  readonly id: string;
  readonly factoryId: string;
  readonly ticket: number;
  readonly stage: string;
  readonly slotId: string;
  readonly contextMessage: string;
}

/** Shared with message acceptance and routing; suspended assignments hold no capacity. */
export const assignedSlot = (query: Query, factoryId: string, ticket: number) =>
  query<{ slot_id: string }>(
    `SELECT slot_id FROM assignment WHERE factory_id = ? AND ticket_number = ? AND status = 'active'`,
    [factoryId, ticket],
  ).pipe(Effect.map((rows) => rows[0]?.slot_id ?? null));

/** Context belongs to its original slot, even after that assignment ends. Never reroute it. */
export const assignmentContextSlot = (change: Change, factoryId: string, messageId: string) =>
  change.query<{ slot_id: string }>(
    `SELECT slot_id FROM assignment WHERE factory_id = ? AND context_message = ?
     UNION ALL SELECT slot_id FROM repository_context WHERE factory_id = ? AND message_id = ?`,
    [factoryId, messageId, factoryId, messageId],
  ).pipe(Effect.map((rows) => rows[0]?.slot_id ?? null));

/** Capacity is active-only, but a suspended worker's messages still belong to its ticket.
 * A new active assignment supersedes suspended work; never revive an ended assignment. */
export const assignmentTicket = (change: Change, factoryId: string, slotId: string) =>
  change.query<{ ticket_number: number }>(
    `SELECT ticket_number FROM assignment WHERE factory_id = ? AND slot_id = ? AND status IN ('active', 'suspended')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1`,
    [factoryId, slotId],
  ).pipe(Effect.map((rows) => rows[0]?.ticket_number ?? null));

/** Transaction-local suspension: releases capacity without ending tracked work or channel I/O. */
export const suspendAssignment = (change: Change, assignmentId: string) =>
  change.query(`UPDATE assignment SET status = 'suspended' WHERE id = ? AND status = 'active'`, [assignmentId]).pipe(Effect.asVoid);

export interface AssignmentFactory {
  readonly factoryId: string;
  readonly config: FactoryConfig;
}

export interface AssignmentSchedulerOptions {
  readonly store: Store;
  readonly factories: ReadonlyArray<AssignmentFactory>;
  readonly slots: ReadonlyArray<PlannedSlot>;
  readonly configLoad?: (factoryId: string) => string | undefined;
  /** Lifecycle/startup gates belong to their own modules. Re-read before each assignment. */
  readonly inScope?: (factoryId: string) => boolean;
  /** Worktree creation is separate; false leaves this ticket queued, without reserving capacity. */
  readonly ready?: (ticket: QueuedTicket, slot: PlannedSlot) => boolean;
  /** Registers a wakeup for when `ready` may have turned true without a commit. Returns an unsubscribe. */
  readonly readinessChanged?: (wake: () => void) => () => void;
  readonly onApprovalError?: (cause: unknown) => void;
  /** Runs outside the assignment transaction, only for an eligible isolated assignment. */
  readonly prepareWorktree?: (ticket: QueuedTicket) => Effect.Effect<void, StoreError>;
  /** Factory clone's default-branch checkout, for non-isolated stations. Enables repository context. */
  readonly clonePath?: (factoryId: string) => string;
}

export interface QueuedTicket {
  readonly factory_id: string;
  readonly number: number;
  readonly title: string;
  readonly slug: string;
  readonly production_line: string;
  readonly directory: string;
  readonly state: string;
  readonly stage: string | null;
  readonly status: string | null;
  readonly worktree_path: string | null;
}

// A scan with no writes is deliberately rolled back, not recorded as a fictitious change.
class NoAssignments extends Data.TaggedError("NoAssignments")<{
  readonly pending: ReadonlyArray<QueuedTicket>;
}> {}

/** One transaction chooses capacity and persists assignments, transitions and context together. */
export const createAssignmentScheduler = (options: AssignmentSchedulerOptions) => {
  const scan = (unverified: ReadonlySet<string>) => options.store.change((change) =>
    Effect.gen(function* () {
      const queued = yield* change.query<QueuedTicket>(
        `SELECT * FROM ticket t WHERE (state = 'backlog' OR (state = 'stage' AND status = 'queued'))
         AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.factory_id = t.factory_id
           AND a.ticket_number = t.number AND a.status = 'active')
         ORDER BY submitted_at, factory_id, number`,
      );

      const assigned: Array<Assignment> = [];
      const pending: Array<QueuedTicket> = [];
      const preparingSlots = new Set<string>();

      for (const ticket of queued) {
        if (options.inScope?.(ticket.factory_id) === false || unverified.has(JSON.stringify([ticket.factory_id, ticket.number]))) {continue;}

        const factory = options.factories.find((f) => f.factoryId === ticket.factory_id);
        const line = factory?.config.production_lines[ticket.production_line];
        const stage = ticket.state === 'backlog' ? line?.stages[0] : line?.stages.find((s) => s.id === ticket.stage);

        if (factory === undefined || stage === undefined) {continue;}

        const [resuming] = yield* change.query<{ id: string; slot_id: string; operator_message: string | null; allow_abandon: number }>(
          `SELECT a.id, a.slot_id, r.operator_message, r.allow_abandon FROM assignment a
           JOIN assignment_resume r ON r.assignment_id = a.id
           WHERE a.factory_id = ? AND a.ticket_number = ? AND a.status = 'suspended'`,
          [ticket.factory_id, ticket.number],
        );

        const suspended = yield* change.query(`SELECT id FROM assignment WHERE factory_id = ? AND ticket_number = ? AND status = 'suspended'`, [ticket.factory_id, ticket.number]);

        if (suspended.length > 0 && resuming === undefined) {continue;}

        const previous = yield* change.query<{ slot_id: string }>(
          `SELECT slot_id FROM assignment WHERE factory_id = ? AND ticket_number = ? AND stage = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          [ticket.factory_id, ticket.number, stage.id],
        );

        const current = yield* change.query<AssignmentSlot>(
          `SELECT s.slot_id, s.condition, EXISTS (
             SELECT 1 FROM assignment a WHERE a.factory_id = s.factory_id
               AND a.slot_id = s.slot_id AND a.status = 'active'
           ) AS busy FROM slot s WHERE s.factory_id = ?`,
          [ticket.factory_id],
        );

        const stationSlots = options.slots.filter((slot) =>
          slot.factoryId === ticket.factory_id && slot.station.address === stage.station);

        const candidates = eligibleAssignmentSlots(stationSlots.flatMap((slot) =>
          current.filter((state) => state.slot_id === slot.slotId)), previous[0]?.slot_id ?? null);

        for (const candidate of candidates) {
          const slot = stationSlots.find((planned) => planned.slotId === candidate.slot_id);

          if (slot === undefined || isAssignmentSlotReserved(options.store, slot.factoryId, slot.slotId)
            || options.ready?.(ticket, slot) === false) {continue;}

          const slotKey = JSON.stringify([slot.factoryId, slot.slotId]);

          if (preparingSlots.has(slotKey)) {continue;}

          if (slot.station.isolation === 'worktree' && ticket.worktree_path === null) {
            if (options.prepareWorktree === undefined) {continue;}

            const attempted = yield* change.query(
              `SELECT 1 FROM operation WHERE factory_id = ? AND ticket_number = ? AND kind = 'worktree_create'`,
              [ticket.factory_id, ticket.number],
            );

            // Failed or interrupted creation needs explicit recovery, not capacity. Other tickets
            // must still be considered, even when the oldest ticket cannot be prepared.
            if (attempted.length > 0) {continue;}

            pending.push(ticket);
            preparingSlots.add(slotKey);
            break;
          }

          if (slot.station.isolation === 'worktree' && factory.config.worktrees?.after_create !== undefined) {
            const hooks = yield* change.query<{ status: string }>(
              `SELECT status FROM operation WHERE factory_id = ? AND ticket_number = ? AND kind = 'hook'
               AND json_extract(intent, '$.hook') = 'after_create'
               AND json_extract(intent, '$.operation') = 'worktree_create'
               AND json_extract(intent, '$.path') = ? ORDER BY id DESC LIMIT 1`,
              [ticket.factory_id, ticket.number, ticket.worktree_path],
            );

            // Missing, running, failed or interrupted setup is never assignment-ready.
            if (hooks[0]?.status !== 'complete') {continue;}
          }

          const now = yield* Clock.currentTimeMillis;

          if (resuming !== undefined && resuming.slot_id === slot.slotId) {
            yield* change.query(`UPDATE assignment SET status = 'active' WHERE id = ?`, [resuming.id]);

            const notice = yield* composeResumeNotice(change, {
              assignmentId: resuming.id, factoryId: ticket.factory_id, ticket: ticket.number,
              stage: stage.id, slotId: slot.slotId, recipient: slot.station.address,
              message: resuming.operator_message,
            });

            yield* change.query(`UPDATE ticket SET status = 'assigned' WHERE factory_id = ? AND number = ?`, [ticket.factory_id, ticket.number]);
            yield* change.query(`DELETE FROM assignment_resume WHERE assignment_id = ?`, [resuming.id]);
            yield* change.query(
              `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
                from_state, from_stage, from_status, to_state, to_stage, to_status, config_load)
               VALUES (?, ?, ?, 'daemon', 'stage', ?, 'queued', 'stage', ?, 'assigned', ?)`,
              [ticket.factory_id, ticket.number, now, stage.id, stage.id, options.configLoad?.(ticket.factory_id) ?? null],
            );
            yield* change.recordHistory({ factoryId: ticket.factory_id, kind: "assignment.reactivated", subject: resuming.id,
              detail: { notice }, records: [ticketRecord(ticket.number), slotRecord(slot.slotId)] });
            assigned.push({ id: resuming.id, factoryId: ticket.factory_id, ticket: ticket.number,
              stage: stage.id, slotId: slot.slotId, contextMessage: notice ?? '' });
            break;
          }

          if (resuming !== undefined) {
            if (resuming.allow_abandon === 0) {continue;}

            yield* abandonAssignment(change, { id: resuming.id, factoryId: ticket.factory_id,
              ticket: ticket.number, now, slots: options.slots });
            yield* change.query(`DELETE FROM assignment_resume WHERE assignment_id = ?`, [resuming.id]);
          }

          const id = randomUUID();

          const repositoryContext = options.clonePath === undefined ? null : yield* composeAssignmentRepositoryContext(change, {
            factoryId: ticket.factory_id, slotId: slot.slotId,
            root: slot.station.isolation === 'worktree' && ticket.worktree_path !== null
              ? ticket.worktree_path : options.clonePath(ticket.factory_id),
          });

          const message = yield* acceptMessage(change, {
            factoryId: ticket.factory_id, senderKind: "daemon", senderSlot: null, recipient: slot.station.address,
            kind: "ordinary", delivery: "after_turn", correlation: { ticket: ticket.number },
            body: `Ticket ${ticket.number}: ${ticket.title}\nProduction line: ${ticket.production_line}\nStage: ${stage.id}\nAssignment: ${id}\nSlot: ${slot.slotId}\nSpecification: ${join(ticket.directory, 'spec.md')}\nEvidence: ${join(ticket.directory, 'evidence')}\nWorktree: ${slot.station.isolation === 'worktree' ? ticket.worktree_path : 'none (write only in the ticket directory)'}${repositoryContext === null ? '' : `\n\n${repositoryContext.body}`}`,
          }).pipe(Effect.catchTag("ToolRefusal", Effect.die)); // No agent guards: daemon context cannot be refused.

          yield* change.query(
            `INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status,
               recovery_ceiling, created_at, context_message) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            [id, ticket.factory_id, ticket.number, stage.id, slot.slotId, factory.config.recovery_limit ?? 3, now, message.id],
          );

          if (resuming !== undefined) {
            yield* composeResumeNotice(change, {
              assignmentId: id, factoryId: ticket.factory_id, ticket: ticket.number,
              stage: stage.id, slotId: slot.slotId, recipient: slot.station.address,
              message: resuming.operator_message,
            });
          }

          if (repositoryContext !== null) {
            yield* recordAssignmentRepositoryContext(change, {
              messageId: message.id, ticket: ticket.number, assignmentId: id, context: repositoryContext,
            });
          }

          yield* change.query(
            `UPDATE ticket SET state = 'stage', stage = ?, status = 'assigned' WHERE factory_id = ? AND number = ?`,
            [stage.id, ticket.factory_id, ticket.number],
          );
          yield* change.query(
            `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
               from_state, from_stage, from_status, to_state, to_stage, to_status, config_load)
             VALUES (?, ?, ?, 'daemon', ?, ?, ?, 'stage', ?, 'assigned', ?)`,
            [ticket.factory_id, ticket.number, now, ticket.state, ticket.stage, ticket.status, stage.id,
              options.configLoad?.(ticket.factory_id) ?? null],
          );
          yield* change.recordHistory({
            factoryId: ticket.factory_id, kind: "ticket.assigned", subject: String(ticket.number),
            detail: { assignment: id, stage: stage.id, slotId: slot.slotId, contextMessage: message.id },
            records: [ticketRecord(ticket.number), slotRecord(slot.slotId)],
          });
          assigned.push({ id, factoryId: ticket.factory_id, ticket: ticket.number, stage: stage.id,
            slotId: slot.slotId, contextMessage: message.id });
          break;
        }
      }

      if (assigned.length === 0) {return yield* new NoAssignments({ pending });}

      return { assigned, pending };
    }),
  ).pipe(Effect.catchTag("NoAssignments", ({ pending }) => Effect.succeed({ assigned: [], pending })));

  return {
    schedule: (): Effect.Effect<ReadonlyArray<Assignment>, StoreError> => Effect.gen(function* () {
      const unverified = new Set<string>();
      yield* voidStaleApprovals({ ...options, waitForLock: true, queuedOnly: true, onUnverified: (factory, ticket, cause) => {
        unverified.add(JSON.stringify([factory, ticket]));
        options.onApprovalError?.(cause);
      } }).pipe(Effect.catch((cause) => Effect.gen(function* () {
        // Preserve main's quiet, deferred SQLite loading; the store is already open here.
        const { StoreError } = yield* Effect.promise(() => import("./store.js"));

        return yield* new StoreError({ reason: "Sql", message: "Could not verify ticket approvals against HEAD", cause });
      })));
      const first = yield* scan(unverified);

      if (options.prepareWorktree === undefined || first.pending.length === 0) {return first.assigned;}

      for (const ticket of first.pending) {
        if (options.inScope?.(ticket.factory_id) !== false) {yield* options.prepareWorktree(ticket);}
      }

      // Recheck capacity, lifecycle and readiness after Git, before committing any assignment.
      const second = yield* scan(unverified);

      return [...first.assigned, ...second.assigned];
    }),
  };
};

/** Coalesced commit wakeups: no polling, no scheduling inside outcome/submission transactions. */
export const watchAssignments = (
  options: AssignmentSchedulerOptions,
  onError: (error: Error) => void,
): (() => Promise<void>) => {
  const preparations = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const prepare = options.prepareWorktree;

  const backgroundPrepare = (ticket: QueuedTicket) => Effect.sync(() => {
      const key = JSON.stringify([ticket.factory_id, ticket.number]);

      if (prepare === undefined || preparations.has(key) || stopped) {return;}

      const controller = new AbortController();

      const done = Effect.runPromiseExit(prepare(ticket), { signal: controller.signal }).then((exit) => {
        if (!stopped && Exit.isFailure(exit)) {onError(new Error(Cause.pretty(exit.cause)));}
      }).finally(() => { preparations.delete(key); });

      preparations.set(key, { controller, done });
    });

  const scheduling = { ...options, onApprovalError: (cause: unknown) => onError(cause instanceof Error ? cause : new Error(String(cause))) };
  const scheduler = createAssignmentScheduler(prepare === undefined ? scheduling : { ...scheduling, prepareWorktree: backgroundPrepare });
  let stopped = false;
  let dirty = false;
  let running: Promise<void> | undefined;

  const wake = () => {
    dirty = true;

    if (running !== undefined || stopped) {return;}

    running = Promise.resolve().then(async () => {
      while (dirty && !stopped) {
        dirty = false;
        const exit = await Effect.runPromiseExit(scheduler.schedule());

        if (Exit.isFailure(exit)) {onError(new Error(Cause.pretty(exit.cause)));}
      }
    }).finally(() => {
      running = undefined;

      // A commit may arrive after the loop's last dirty check but before this finalizer.
      // Release ownership and recheck together, or that wakeup would have no runner.
      if (dirty && !stopped) {wake();}
    });
  };

  const unsubscribe = options.store.onCommit(wake);
  const unreserve = onAssignmentSlotReleased(options.store, wake);
  const unready = options.readinessChanged?.(wake);
  wake();

  return async () => {
    stopped = true;
    unsubscribe();
    unreserve();
    unready?.();
    await running;
    const pending = [...preparations.values()];

    for (const preparation of pending) {preparation.controller.abort();}

    await Promise.all(pending.map((preparation) => preparation.done));
  };
};
