/**
 * Who holds a slot, decided from the Worker Host's report and the daemon's records (PRD §3.2,
 * §10.2 step 2). Pure: the scheduler acts on the answer at start, and the unfreeze check of the
 * `host_lost` and `unknown_ownership` causes asks it again.
 *
 * Only proven launches are adopted: the slot's recorded current launch, or one the daemon asked of
 * this same host process. A live launch nobody can trace to a request, or several live launches in
 * one slot, is unknown ownership. A recorded launch the host answering now does not know, on the
 * same machine boot, means the host that started it was lost, and its process group may still run.
 * A different boot is positive proof that every earlier launch is gone.
 */
import type { LaunchRecord } from "@foundry/host";
import type { HoldEvidence } from "@foundry/protocol/holds";
import type { FreezeCause } from "@foundry/protocol/slots-api";

/** The slot's current launch as the daemon recorded it. */
export interface RecordedLaunch {
  readonly launchId: string;
  /** The boot it was started in; `null` when no launch row exists for the ID. */
  readonly bootId: string | null;
  /** Whether its end is recorded (a missing row counts as ended). */
  readonly ended: boolean;
}

/** What the daemon's records say about one slot. */
export interface RecordedSlot {
  /** The current launch, or `null` if the slot has never had one. */
  readonly current: RecordedLaunch | null;
  /** A launch requested but not yet recorded: the host process and boot it was asked of. */
  readonly pending: { readonly hostId: string; readonly bootId: string } | null;
  /** Every launch ID recorded for the slot. */
  readonly recorded: ReadonlySet<string>;
}

/** What the host answering now reports about one slot. */
export interface HostReport {
  readonly hostId: string;
  readonly bootId: string;
  /** The host's launches in this slot, live or gone. */
  readonly launches: ReadonlyArray<LaunchRecord>;
}

/** Why ownership could not be proven, as shown in the frozen-slot hold. */
export type UnprovenReason =
  /** The host reports more than one live launch in the slot. */
  | "several_live_launches"
  /** The host reports a live launch the daemon never recorded nor asked this host for. */
  | "unrecorded_live_launch"
  /** The recorded current launch is unknown to this host, on the same boot. */
  | "recorded_launch_unknown_to_host"
  /** A launch was asked of an earlier host on this boot, which may have started it. */
  | "requested_of_earlier_host";

/**
 * - `running`: the recorded current launch is live; it is kept, never replaced.
 * - `claimed`: a launch this same host started for the daemon's pending request; record it (and its
 *   end, if it is already gone).
 * - `ended`: the current launch's end is recorded or reported; the slot is vacant.
 * - `rebooted`: the current launch is from an earlier boot, so it is gone; the slot is vacant.
 * - `unlaunched`: the slot has never had a launch and none can be running; it may get its first.
 * - `frozen`: ownership is unproven; nothing is adopted or launched.
 */
export type SlotOwnership =
  | { readonly kind: "running"; readonly launchId: string }
  | { readonly kind: "claimed"; readonly launch: LaunchRecord }
  | { readonly kind: "ended"; readonly launchId: string }
  | { readonly kind: "rebooted"; readonly launchId: string }
  | { readonly kind: "unlaunched" }
  | {
      readonly kind: "frozen";
      readonly cause: FreezeCause;
      readonly reason: UnprovenReason;
      /** The launch the question is about, if there is one. */
      readonly launchId: string | null;
      readonly evidence: HoldEvidence;
    };

const frozen = (cause: FreezeCause, reason: UnprovenReason, launchId: string | null, host: HostReport): SlotOwnership => ({
  kind: "frozen",
  cause,
  reason,
  launchId,
  evidence: {
    reason,
    launchId,
    hostId: host.hostId,
    bootId: host.bootId,
    hostReport: host.launches.map((launch) => ({
      launchId: launch.launchId,
      liveness: launch.liveness,
      pid: launch.pid,
      bootId: launch.bootId,
      startedAt: launch.startedAt,
    })),
  },
});

/** Decides who holds a slot; see the module comment for the rules. */
export const classifyOwnership = (slot: RecordedSlot, host: HostReport): SlotOwnership => {
  const live = host.launches.filter((launch) => launch.liveness === "live");

  // Never pick one of several: whichever is kept, the other would still be a second worker.
  if (live.length > 1) {return frozen("unknown_ownership", "several_live_launches", slot.current?.launchId ?? null, host);}

  const [only] = live;

  if (only !== undefined) {
    if (slot.current?.launchId === only.launchId) {return { kind: "running", launchId: only.launchId };}

    // The reply to a request on this same host was lost: the live launch is the one it started.
    if (slot.pending?.hostId === host.hostId) {return { kind: "claimed", launch: only };}

    return frozen("unknown_ownership", "unrecorded_live_launch", only.launchId, host);
  }

  const { current } = slot;

  if (current !== null && !current.ended) {
    // The host knows it and does not report it live: it is gone.
    if (host.launches.some((launch) => launch.launchId === current.launchId)) {return { kind: "ended", launchId: current.launchId };}

    if (current.bootId !== host.bootId) {return { kind: "rebooted", launchId: current.launchId };}

    return frozen("host_lost", "recorded_launch_unknown_to_host", current.launchId, host);
  }

  // The records say the slot is vacant. A pending request is checked before that is trusted: a
  // relaunch into a slot whose launch ended (FOU-51) is requested with the old launch still current.
  if (slot.pending !== null) {
    if (slot.pending.hostId === host.hostId) {
      // The same host process knows every launch it started; one that has since ended was ours.
      const gone = host.launches.find((launch) => !slot.recorded.has(launch.launchId));

      if (gone !== undefined) {return { kind: "claimed", launch: gone };}
    } else if (slot.pending.bootId === host.bootId) {
      return frozen("host_lost", "requested_of_earlier_host", null, host);
    }
    // Otherwise the machine restarted since the request, which proves any launch gone.
  }

  if (current !== null) {return { kind: "ended", launchId: current.launchId };}

  return { kind: "unlaunched" };
};
