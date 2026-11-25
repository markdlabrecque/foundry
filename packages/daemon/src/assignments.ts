/** Committed-state assignment step (PRD §8.2, §10.1), independent of outcome handlers. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Cause, Clock, Data, Effect, Exit } from "effect";
import { acceptMessage } from "./agent-message.js";
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

export const assignmentTicket = (change: Change, factoryId: string, slotId: string) =>
  change.query<{ ticket_number: number }>(
    `SELECT ticket_number FROM assignment WHERE factory_id = ? AND slot_id = ? AND status = 'active'`,
    [factoryId, slotId],
  ).pipe(Effect.map((rows) => rows[0]?.ticket_number ?? null));

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
}

export interface QueuedTicket {
  readonly factory_id: string;
  readonly number: number;
  readonly title: string;
  readonly production_line: string;
  readonly directory: string;
  readonly state: string;
  readonly stage: string | null;
  readonly status: string | null;
  readonly worktree_path: string | null;
}

// A scan with no writes is deliberately rolled back, not recorded as a fictitious change.
class NoAssignments extends Data.TaggedError("NoAssignments") {}

/** One transaction chooses capacity and persists assignments, transitions and context together. */
export const createAssignmentScheduler = (options: AssignmentSchedulerOptions) => ({
  schedule: (): Effect.Effect<ReadonlyArray<Assignment>, StoreError> => options.store.change((change) =>
    Effect.gen(function* () {
      const queued = yield* change.query<QueuedTicket>(
        `SELECT * FROM ticket t WHERE (state = 'backlog' OR (state = 'stage' AND status = 'queued'))
         AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.factory_id = t.factory_id
           AND a.ticket_number = t.number AND a.status != 'ended')
         ORDER BY submitted_at, factory_id, number`,
      );

      const assigned: Array<Assignment> = [];

      for (const ticket of queued) {
        if (options.inScope?.(ticket.factory_id) === false) {continue;}

        const factory = options.factories.find((f) => f.factoryId === ticket.factory_id);
        const line = factory?.config.production_lines[ticket.production_line];
        const stage = ticket.state === 'backlog' ? line?.stages[0] : line?.stages.find((s) => s.id === ticket.stage);

        if (factory === undefined || stage === undefined) {continue;}

        for (const slot of options.slots) {
          if (slot.factoryId !== ticket.factory_id || slot.station.address !== stage.station) {continue;}

          const capacity = yield* change.query(
            `SELECT 1 FROM slot s WHERE factory_id = ? AND slot_id = ? AND condition = 'normal'
             AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.factory_id = s.factory_id
               AND a.slot_id = s.slot_id AND a.status = 'active')`,
            [slot.factoryId, slot.slotId],
          );

          if (capacity.length === 0 || options.ready?.(ticket, slot) === false) {continue;}

          // Until the worktree ticket wires its readiness seam, never assign an isolation:worktree
          // station a ticket without a materialized worktree.
          if (slot.station.isolation === 'worktree' && ticket.worktree_path === null) {continue;}

          const id = randomUUID();
          const now = yield* Clock.currentTimeMillis;

          const message = yield* acceptMessage(change, {
            factoryId: ticket.factory_id, senderSlot: "", recipient: slot.station.address,
            kind: "ordinary", delivery: "after_turn", correlation: { ticket: ticket.number },
            body: `Ticket ${ticket.number}: ${ticket.title}\nProduction line: ${ticket.production_line}\nStage: ${stage.id}\nAssignment: ${id}\nSlot: ${slot.slotId}\nSpecification: ${join(ticket.directory, 'spec.md')}\nEvidence: ${join(ticket.directory, 'evidence')}\nWorktree: ${ticket.worktree_path ?? 'none (write only in the ticket directory)'}`,
          }).pipe(Effect.catchTag("ToolRefusal", Effect.die)); // No agent guards: daemon context cannot be refused.

          yield* change.query(
            `INSERT INTO assignment (id, factory_id, ticket_number, stage, slot_id, status,
               recovery_ceiling, created_at, context_message) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            [id, ticket.factory_id, ticket.number, stage.id, slot.slotId, factory.config.recovery_limit ?? 3, now, message.id],
          );
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

      if (assigned.length === 0) {return yield* new NoAssignments();}

      return assigned;
    }),
  ).pipe(Effect.catchTag("NoAssignments", () => Effect.succeed([]))),
});

/** Coalesced commit wakeups: no polling, no scheduling inside outcome/submission transactions. */
export const watchAssignments = (
  options: AssignmentSchedulerOptions,
  onError: (error: Error) => void,
): (() => Promise<void>) => {
  const scheduler = createAssignmentScheduler(options);
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
  wake();

  return async () => { stopped = true; unsubscribe(); await running; };
};
