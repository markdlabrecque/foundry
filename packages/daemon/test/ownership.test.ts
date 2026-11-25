// Tier: unit. `classifyOwnership` is a pure function of the daemon's records and the host's
// report, so every rule of PRD §10.2 step 2 is proved here without a host or a store. The
// integration test (test/daemon-restart-ownership.test.ts) proves the wiring once.
import { expect, test } from "vitest";
import { classifyOwnership } from "@foundry/daemon";
import type { HostReport, RecordedSlot } from "@foundry/daemon";
import type { LaunchRecord } from "@foundry/host";

const launch = (launchId: string, liveness: "live" | "gone", bootId = "boot-1"): LaunchRecord =>
  liveness === "live"
    ? { launchId, factoryId: "f1", slotId: "dev/1", pid: 10, pgid: 10, bootId, startedAt: "2026-01-01T00:00:00.000Z", liveness }
    : {
        launchId,
        factoryId: "f1",
        slotId: "dev/1",
        pid: 10,
        pgid: 10,
        bootId,
        startedAt: "2026-01-01T00:00:00.000Z",
        liveness,
        exit: { code: 0, signal: null, endedAt: "2026-01-01T00:01:00.000Z" },
      };

const host = (launches: ReadonlyArray<LaunchRecord>, hostId = "host-2", bootId = "boot-1"): HostReport => ({ hostId, bootId, launches });

const slot = (overrides: Partial<RecordedSlot> = {}): RecordedSlot => ({ current: null, pending: null, recorded: new Set(), ...overrides });

const current = (launchId: string, bootId = "boot-1", ended = false) => ({ launchId, bootId, ended });

test.each([
  ["the recorded current launch, still live, is kept", slot({ current: current("L1"), recorded: new Set(["L1"]) }), host([launch("L1", "live")]), { kind: "running", launchId: "L1" }],
  ["a recorded launch the host reports gone has ended", slot({ current: current("L1") }), host([launch("L1", "gone")]), { kind: "ended", launchId: "L1" }],
  ["a recorded end stands", slot({ current: current("L1", "boot-1", true) }), host([]), { kind: "ended", launchId: "L1" }],
  ["a recorded launch from an earlier boot is gone after a reboot", slot({ current: current("L1", "boot-0") }), host([]), { kind: "rebooted", launchId: "L1" }],
  ["a never-launched slot with nothing live may get its first launch", slot(), host([]), { kind: "unlaunched" }],
  ["a request of an earlier host on an earlier boot proves nothing runs", slot({ pending: { hostId: "host-1", bootId: "boot-0" } }), host([]), { kind: "unlaunched" }],
])("%s", (_name, recorded, report, expected) => {
  expect(classifyOwnership(recorded, report)).toEqual(expected);
});

test("a launch this same host started for a lost reply is claimed, live or gone", () => {
  const pending = { hostId: "host-2", bootId: "boot-1" };
  const live = launch("L2", "live");
  const gone = launch("L3", "gone");

  expect(classifyOwnership(slot({ pending }), host([live]))).toEqual({ kind: "claimed", launch: live });
  expect(classifyOwnership(slot({ pending, recorded: new Set(["L1"]) }), host([launch("L1", "gone"), gone]))).toEqual({ kind: "claimed", launch: gone });
});

test.each([
  ["an unrecorded live launch nobody asked this host for", slot(), host([launch("orphan", "live")]), "unknown_ownership", "unrecorded_live_launch", "orphan"],
  ["a live launch other than the recorded current one", slot({ current: current("L1") }), host([launch("orphan", "live")]), "unknown_ownership", "unrecorded_live_launch", "orphan"],
  ["several live launches in one slot", slot({ current: current("a") }), host([launch("a", "live"), launch("b", "live")]), "unknown_ownership", "several_live_launches", "a"],
  ["a recorded launch a new host on the same boot does not know", slot({ current: current("L1") }), host([]), "host_lost", "recorded_launch_unknown_to_host", "L1"],
  ["a request of an earlier host on the same boot", slot({ pending: { hostId: "host-1", bootId: "boot-1" } }), host([]), "host_lost", "requested_of_earlier_host", null],
])("%s freezes, never adopts", (_name, recorded, report, cause, reason, launchId) => {
  expect(classifyOwnership(recorded, report)).toMatchObject({
    kind: "frozen",
    cause,
    reason,
    launchId,
    evidence: { reason, launchId, hostId: "host-2", bootId: "boot-1", hostReport: report.launches.map((l) => ({ launchId: l.launchId, liveness: l.liveness })) },
  });
});

test("a relaunch requested into a slot whose launch ended is settled from the request, not trusted vacant", () => {
  const ended = current("L1", "boot-1", true);
  const gone = launch("L2", "gone");

  // The same host started it for the pending relaunch and it has already gone: claimed.
  expect(classifyOwnership(slot({ current: ended, pending: { hostId: "host-2", bootId: "boot-1" }, recorded: new Set(["L1"]) }), host([launch("L1", "gone"), gone]))).toEqual({
    kind: "claimed",
    launch: gone,
  });
  // Asked of an earlier host on this boot, which may have started it: frozen as host lost.
  expect(classifyOwnership(slot({ current: ended, pending: { hostId: "host-1", bootId: "boot-1" }, recorded: new Set(["L1"]) }), host([]))).toMatchObject({
    kind: "frozen",
    cause: "host_lost",
    reason: "requested_of_earlier_host",
  });
  // Asked before a reboot: nothing can be running, so the slot is vacant after its ended launch.
  expect(classifyOwnership(slot({ current: ended, pending: { hostId: "host-1", bootId: "boot-0" } }), host([]))).toEqual({ kind: "ended", launchId: "L1" });
});
