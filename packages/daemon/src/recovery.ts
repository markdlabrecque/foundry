/** Unexpected launch-end accounting and atomic parking (PRD §5.3, §10.2). */
import { Clock, Effect } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import { slotRecord, ticketRecord } from "./history-records.js";
import { raiseHoldIn } from "./holds.js";
import type { Change } from "./store.js";

interface RecoveryAssignment {
  readonly id: string;
  readonly ticket_number: number;
  readonly recovery_count: number;
  readonly recovery_ceiling: number;
}

/** Runs in the transaction that first records the end, never on a replayed end. */
export const countUnexpectedEndIn = (
  change: Change,
  factoryId: string,
  slotId: string,
  launchId: string,
  limit: number,
  configLoad: string | null,
) => Effect.gen(function* () {
  // A late report of a replaced launch must not charge a newer assignment or idle period.
  const current = yield* change.query<{ condition: string }>(
    `SELECT condition FROM slot WHERE factory_id = ? AND slot_id = ? AND current_launch = ?`,
    [factoryId, slotId, launchId],
  );

  if (current[0] === undefined || current[0].condition === "parked") {return;}

  const assignments = yield* change.query<RecoveryAssignment>(
    `SELECT id, ticket_number, recovery_count, recovery_ceiling FROM assignment
     WHERE factory_id = ? AND slot_id = ? AND status = 'active'`, [factoryId, slotId],
  );

  const assignment = assignments[0];
  let count: number;
  const ceiling = assignment?.recovery_ceiling ?? limit;

  if (assignment === undefined) {
    const rows = yield* change.query<{ recovery_count: number }>(
      `UPDATE slot SET recovery_count = recovery_count + 1 WHERE factory_id = ? AND slot_id = ? RETURNING recovery_count`,
      [factoryId, slotId],
    );

    count = expectDefined(rows[0], `slot ${slotId}`).recovery_count;
  } else {
    count = assignment.recovery_count + 1;
    yield* change.query(`UPDATE assignment SET recovery_count = ? WHERE id = ?`, [count, assignment.id]);
  }

  if (count < ceiling) {return;}

  const now = yield* Clock.currentTimeMillis;

  if (assignment !== undefined) {
    yield* change.query(`UPDATE assignment SET status = 'suspended' WHERE id = ?`, [assignment.id]);
    yield* change.query(
      `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor,
         from_state, from_stage, from_status, to_state, to_stage, to_status, config_load)
       SELECT factory_id, number, ?, 'daemon', state, stage, status, state, stage, 'paused', ?
       FROM ticket WHERE factory_id = ? AND number = ?`,
      [now, configLoad, factoryId, assignment.ticket_number],
    );
    yield* change.query(`UPDATE ticket SET status = 'paused' WHERE factory_id = ? AND number = ?`,
      [factoryId, assignment.ticket_number]);
  }

  yield* change.query(`UPDATE slot SET condition = 'parked', freeze_cause = NULL WHERE factory_id = ? AND slot_id = ?`,
    [factoryId, slotId]);

  const launches = yield* change.query<{ launch_id: string; end_reason: string; exit_code: number | null; exit_signal: string | null }>(
    `SELECT launch_id, end_reason, exit_code, exit_signal FROM launch
     WHERE factory_id = ? AND slot_id = ? AND ended_at IS NOT NULL ORDER BY started_at, launch_id`, [factoryId, slotId],
  );

  const evidence = { launchId, recoveryCount: count, recoveryCeiling: ceiling,
    ticket: assignment?.ticket_number ?? null, assignment: assignment?.id ?? null, launches };

  yield* raiseHoldIn(change, { factoryId, kind: "parked_slot", subject: slotId, evidence });
  yield* change.recordHistory({ factoryId, kind: "slot.parked", subject: slotId, detail: evidence,
    records: assignment === undefined ? [slotRecord(slotId)] : [slotRecord(slotId), ticketRecord(assignment.ticket_number)] });
});
