/**
 * `agent_status` (PRD §6.1): observed slot state, scoped to the authenticated sender's factory.
 * Reads in the submission transaction so the recorded answer is one consistent snapshot.
 * A normal condition or an unended launch is not proof of idle, reachable or host-confirmed
 * vacant capacity. This tool reports those observations, never reserves a slot or probes a host.
 */
import { Effect } from "effect";
import { discoverFactory } from "./agent-discover.js";
import type { PlannedSlot } from "./slots.js";
import type { ToolHandler } from "./submissions.js";

interface SlotObservation {
  readonly slot_id: string;
  readonly condition: string;
  readonly freeze_cause: string | null;
  readonly current_launch: string | null;
  readonly pending_host: string | null;
  readonly ended_at: number | null;
  readonly observed_launch: string | null;
}

export const agentStatusHandler = (slots: ReadonlyArray<PlannedSlot>): ToolHandler =>
  (change, call) => Effect.gen(function* () {
    const rows = yield* change.query<SlotObservation>(
      `SELECT s.slot_id, s.condition, s.freeze_cause, s.current_launch, s.pending_host, l.ended_at, l.launch_id AS observed_launch
       FROM slot s LEFT JOIN launch l ON l.launch_id = s.current_launch
         AND l.factory_id = s.factory_id AND l.slot_id = s.slot_id
       WHERE s.factory_id = ?`,
      [call.factoryId],
    );

    const bySlot = new Map(rows.map((row) => [row.slot_id, row]));
    const discovered = discoverFactory(slots, call.factoryId);

    const stations = discovered.stations.map((station) => ({
      address: station.address,
      capacity: station.slots.length,
      slots: station.slots.map((slotId) => {
        const row = bySlot.get(slotId);

        return {
          slotId,
          condition: row?.condition ?? "unknown",
          freezeCause: row?.freeze_cause ?? null,
          recordedLaunch: row !== undefined && row.pending_host !== null ? "starting"
            : row === undefined || row.current_launch === null ? "none"
            : row.observed_launch === null ? "unknown"
            : row.ended_at === null ? "unended" : "ended",
        };
      }),
    }));

    return { factory: call.factoryId, stations };
  });
