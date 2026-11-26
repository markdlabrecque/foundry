#!/usr/bin/env node
// FOU-155 manual real-process wiring, not a commit-tier timing test.
// Use a short disk-backed TMPDIR; see ../sdk-54-4-linux.md.
// Retain the RPC sibling's raw result unchanged; assess the SDK contract separately.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "sdk155-out-")));
process.argv[2] = out;
process.argv[3] = "sdk";
await import("../rpc-54-4-linux/run-probe.mjs");

const raw = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
const event = (name) => raw.log.find((entry) => entry.event === name);
const before = event("before stop");
const stopped = event("after stop");
const after = event("after shutdown");
const stop = event("factory stop alpha");
const down = event("shutdown");
const alpha = before?.launches.filter((launch) => launch.factoryId === "alpha") ?? [];
const beta = before?.launches.filter((launch) => launch.factoryId === "beta") ?? [];
const launches = [...alpha, ...beta];
const ids = (items) => items.map((item) => item.launchId).sort().join();
const absent = (items, key, expected) => items?.length === expected.length && expected.every((id) => items.some((item) => item[key] === id && item.alive === false));
const bounded = (command) => command?.exitCode === 0 && command.ms > 0 && command.ms <= 17_000;
// Defaults: 5s drain + 5s SIGTERM grace + 5s kill confirmation; allow 2s CLI overhead.
const stopLaunches = stop?.body?.result?.launches ?? [];
const downLaunches = down?.body?.result?.factories?.flatMap((factory) => factory.launches) ?? [];
const children = before?.holds.map((hold) => hold.childPid) ?? [];
const checks = {
  explicitSdk: event("versions")?.runtime === "sdk" && before?.holds.length === 3 && before.holds.every((hold) => hold.argv[0].endsWith("/packages/host/dist/sdk-worker.js")),
  activeOwnedFixture: alpha.length === 2 && beta.length === 1 && children.length === 3 && new Set(children).size === 3 && launches.every((launch) => {
    const hold = before.holds.find((item) => item.launchId === launch.launchId);
    return hold?.workerPid === launch.pid && before.groupMembers.some((member) => member.pid === hold.childPid && member.ppid === launch.pid && member.pgid === launch.pgid && !member.stat.startsWith("Z"));
  }),
  scopedStopBounded: bounded(stop) && stop.body?.result?.state === "stopped" && stopLaunches.length === 2 && ids(stopLaunches) === ids(alpha),
  alphaEscalated: stopLaunches.length === 2 && stopLaunches.every((launch) => launch.escalated === true),
  alphaAbsentBeforeShutdown: absent(stopped?.alphaGroupsAlive, "pgid", alpha.map((launch) => launch.pgid)) && absent(stopped?.alphaChildrenAlive, "pid", before?.holds.filter((hold) => hold.factoryId === "alpha").map((hold) => hold.childPid) ?? []) && stopped?.groupMembers.every((member) => !alpha.some((launch) => launch.pgid === member.pgid)),
  originalBetaSurvives: beta.length === 1 && stopped?.hostRecords.some((record) => record.launchId === beta[0].launchId && record.pid === beta[0].pid && record.pgid === beta[0].pgid && record.liveness === "live") && stopped.groupMembers.some((member) => member.pid === beta[0].pid && member.pgid === beta[0].pgid && !member.stat.startsWith("Z")) && stopped.groupMembers.some((member) => member.pid === before.holds.find((hold) => hold.launchId === beta[0].launchId)?.childPid && member.pgid === beta[0].pgid && !member.stat.startsWith("Z")),
  betaShutdownBoundedAndEscalated: bounded(down) && down.body?.result?.hostStopped === true && downLaunches.length === 1 && ids(downLaunches) === ids(beta) && downLaunches.every((launch) => launch.escalated === true),
  absentBeforeFallbackCleanup: launches.length === 3 && absent(after?.groupsAlive, "pgid", launches.map((launch) => launch.pgid)) && absent(after?.childrenAlive, "pid", children) && after?.groupMembers.length === 0 && after.runProcessesLeft.length === 0 && after.hostAlive === false && after.daemonExit === 0,
};
const assessment = {
  result: !before || !after ? "inconclusive" : Object.values(checks).every(Boolean) ? "supported" : "blocked-on-tested-approach",
  scope: "PRD 17.2 item 3, Linux explicit stop only; not whole-launcher qualification",
  rawResult: raw.result,
  rawChecks: raw.checks,
  checks,
  durationBoundMs: 17_000,
  note: "The raw child-outlives-leader flags remain diagnostic. SDK may keep both leader and child alive until group SIGKILL. All contract checks above must pass independently; raw results are never rewritten.",
};
writeFileSync(join(out, "sdk-assessment.json"), `${JSON.stringify(assessment, null, 2)}\n`);
console.log(JSON.stringify({ event: "SDK contract assessment", ...assessment }));
process.exitCode = assessment.result === "supported" ? 0 : 1;
