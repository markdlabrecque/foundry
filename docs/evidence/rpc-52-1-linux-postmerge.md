# Linux RPC survival and reconnect: post-merge acceptance

Ticket: [FOU-83](https://linear.app/foundry-mdl/issue/FOU-83/check-rpc-survival-and-reconnect-on-linux). Contract: PRD §17.2 item 1 (draft 52a / launch gate 52-1). Run: 2026-11-26, 02:40:23–02:40:52 UTC.

## Outcome and disposition

**Supported on this tested Linux RPC approach: all 11 original observations pass.** Two busy original Pi workers and their original Worker Host survived daemon-only SIGKILL, retained the same launch IDs, PIDs, PGIDs and slots, authenticated to the restarted daemon and resumed actual channel heartbeat traffic. No replacement launches occurred.

This is fresh acceptance after [FOU-162](https://linear.app/foundry-mdl/issue/FOU-162/workers-reconnect-after-a-daemon-restart) merged as `477b169f2b23a1a952008b2f5d7a5b28d02324bb` ([PR 144](https://github.com/markdlabrecque/foundry/pull/144)). Exact product tree tested: `089ab52ac2deeeac53c59e8597605bcad309127a`, fetched `origin/develop`, with clean tracked/untracked status at probe start. This branch adds only this separate report and artifacts; no product, automated tests, testkit, original probe, normalizer or historical failure evidence changed.

The [historical failed investigation](rpc-52-1-linux.md) and its [result](rpc-52-1-linux/result.json) remain unchanged. Its missing-redial diagnosis describes that earlier product version, not this rerun. FOU-83 remains **In Progress pending fresh independent review**; this report is not a tracker-closing or release-qualification action. Live issue, comments (none on FOU-83/162), dependencies FOU-70/95/85 and their comments were read; all four recorded implementation prerequisites are Done. FOU-136's downstream RPC gate decision is not made here. T3 issue linking was attempted but returned `Issues cannot be browsed for this project yet.`

## Exact environment, fixture and launcher

- Node `v22.23.2`; npm `10.9.8`; repository-pinned Pi `1.6.0` installed by `npm ci`.
- Linux x64, kernel `7.2.15-1-omarchy` (Omarchy). Fresh disposable Worker Host uses host-control protocol **5** from this product tree. No existing/operator host was contacted or stopped.
- The existing portable [RPC driver](rpc-52-1-linux/run-probe.mjs) and [busy extension](rpc-52-1-linux/probe-extension.ts) ran **unchanged**, including the 45,000 ms maximum reconnect window and all 11 checks. No probe correction was needed.
- Deliberately conflicting caller `FOUNDRY_WORKER_RUNTIME=sdk`; the RPC entry point explicitly sets child runtime `rpc`. Recorded `versions.runtime`, ordered worker argv and actual `rpc-entry.js --mode rpc` independently show RPC selection.
- `FOUNDRY_PI_BIN` unset for build, checks and probe; no shim/diagnostic wrapper. The host resolves the pinned repository Pi bundle normally.
- Short, private, home-backed parent `TMPDIR` made by `mktemp -d "$HOME/.f83-XXXX"`. The driver creates a fresh fixture inside it and explicitly passes `TMPDIR=<fixture-root>/tmp` to all fixture children.
- Only `PATH` is inherited into fixture children. Disposable HOME, XDG config/data/cache, `PI_CODING_AGENT_DIR`, `FOUNDRY_HOME`, Git identity/config and exact `PROBE_DIR` ownership marker are driver-defined. Agent settings disable install telemetry; `PI_OFFLINE=1`, `PI_TELEMETRY=0`. No credentials, paid models, 1Password, network provider or production resources.
- Effective factory is retained verbatim apart from prefix normalization in [alpha.yaml](rpc-52-1-linux-postmerge/artifacts/alpha.yaml): local throwaway Git source, factory alpha, station eng.hold, two worktree-isolated instances, explicit faux `probe/busy`, configured `probe_hold`. Each worker starts one run and remains inside that held tool across kill/restart. Original hold records, including timestamps, remain identical after restart.

Exact daemon argv, on each start:

```text
<node> <repo>/packages/daemon/dist/main.js --home <fixture-root>/home --log-level debug <fixture-root>/alpha.yaml
```

Exact ordered worker argv for hold/1 (empty strings are actual arguments):

```text
<node>
<repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js
--mode rpc
--system-prompt "" --append-system-prompt ""
--no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
--no-context-files --no-approve
--session-id bcb541df-0acb-4496-b1a0-ccedf54770a8
--model probe/busy
--tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold
--extension <repo>/packages/extension/dist/index.js
--extension <repo>/docs/evidence/rpc-52-1-linux/probe-extension.ts
```

Cwd: `<fixture-root>/home/slots/alpha/hold-1`. Hold/2 has the same ordered options, session ID `bf7d1597-1b48-4ec1-9f82-bb3dae5562a4`, cwd ending `hold-2`. Both complete arrays and executable are retained in [summary.json](rpc-52-1-linux-postmerge/artifacts/summary.json), `before kill.holds` and `after restart.probeHoldsNow`. No argv sorting or filtering occurred.

## Observations and per-criterion actuals

Original host before/after: PID `3142150`, host ID `f541ed47-b962-4f97-8880-ae9022a57908`, boot ID `e4653541-62f1-4746-93c3-19c8d32b3110`.

| Slot | Original launch ID, unchanged after restart | Original PID = PGID, unchanged | Held tool entered (UTC) | Accepted by restarted daemon (UTC) |
|---|---|---|---|---|
| hold/1 | `1502ade1-67aa-4c4b-a630-6f56567c2065` | `3142162` | 02:40:25.388 | 02:40:35.635 |
| hold/2 | `7b37a63d-16e5-4d3e-aea4-f002331966be` | `3142168` | 02:40:25.401 | 02:40:35.638 |

The owned first daemon PID `3142135` alone received SIGKILL at `02:40:31.873`; exit signal was `SIGKILL`, code null. At `02:40:33.933` the original host and workers were still alive, with their host socket connections intact and their old daemon socket connections gone. New daemon PID `3142572` served the same state root at `02:40:34.137`. It adopted both original launches before serving.

Both authenticated `channel accepted` events arrived about 1.5 seconds after serving, with the original factory/slot/launch identity and Tool Set count 13. Actual received `heartbeat` frames followed at `02:40:40.637` / `.640` and `02:40:45.641` / `.644`. Each worker's socket observation then points to new daemon PID `3142572` and original host PID `3142150`. The driver finished its observation after **12,012 ms**, using its existing early-success condition (two post-accept heartbeats each), not a shortened maximum or relaxed assertion. Subsequent shutdown-time traffic is not counted toward this result.

| Original check | Result and direct evidence |
|---|---|
| `fixtureShape` | **true**: two live launches in distinct slots and two busy hold records. |
| `connectedBeforeKill` | **true**: one accepted channel, one receipt and one heartbeat per original launch before kill. |
| `daemonKilledAbruptly` | **true**: first daemon exit signal SIGKILL. |
| `workersAndHostSurviveKill` | **true**: signal-0 observations for both original worker PIDs and host after daemon death. |
| `sameHostAfterRestart` | **true**: identical host ID and PID; recorded boot ID identical too. |
| `workersStillAlive` | **true**: original worker PIDs alive after reconnect observation. |
| `sameLaunchesInSlots` | **true**: original launches in hold/1 and hold/2, both normal, null endedAt/freezeCause. |
| `noReplacement` | **true**: inventory contains exactly original two live launches; host log has exactly two launch starts, both before kill; unchanged busy hold records. PID and PGID inventories also match exactly. |
| `reconnectedToRestartedDaemon` | **true**: one authenticated accept per original launch in restarted-daemon log. |
| `channelTrafficResumed` | **true**: two actual post-accept heartbeats per original launch before shutdown. |
| `shutdownLeavesNothing` | **true**: disposable-instance shutdown exit 0, hostStopped true, daemon exit 0, host gone, no marker-owned processes. |

Primary evidence: [summary](rpc-52-1-linux-postmerge/artifacts/summary.json), [daemon log](rpc-52-1-linux-postmerge/artifacts/daemon.log), [host log](rpc-52-1-linux-postmerge/artifacts/host.log). Logs contain frame types, not payloads. There were no post-restart refusals, replacements or holds. Channel losses/launch ends at 02:40:51–52 belong to final deliberate shutdown, not the reconnect observation.

## Verification and reproduction

Commands actually ran in this order; all exit 0. There is no automated-test change: the manual real-process journey proves launcher/extension/daemon wiring that cheaper deterministic tests cannot establish.

```sh
scratch=$(mktemp -d "$HOME/.f83-XXXX")
export TMPDIR="$scratch"
unset FOUNDRY_PI_BIN
npm ci
npm run build
FOUNDRY_WORKER_RUNTIME=sdk node docs/evidence/rpc-52-1-linux/run-probe.mjs "$scratch/probe"
npm run typecheck
./node_modules/.bin/oxlint
npm test
npm run test:e2e
# Supplemental read-only /proc group and marker inspection, then normalize evidence.
# See group-cleanup.json for method and exact observed IDs.
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$scratch/probe" docs/evidence/rpc-52-1-linux-postmerge/artifacts
git diff --check
```

The existing normalizer expects `group-cleanup.json` alongside probe output. For this run, a supplemental read-only `/proc` inspection wrote that record after the probe: it compared process-group IDs from `/proc/<pid>/stat` against the two recorded worker PGIDs and scanned exact NUL-delimited environment markers. It also checked the three original host/worker PID paths and fixture-root absence. No signal was sent by that inspection. The record is retained, not a change to the acceptance driver.

| Validation | Actual |
|---|---|
| npm ci / normal build / typecheck | All exit 0 |
| direct `./node_modules/.bin/oxlint` | Exit 0, no diagnostics |
| full `npm test` | **105 files, 862 tests passed**, 18.19 s |
| separate `npm run test:e2e` | **3 files, 5 tests passed**, 7.90 s |
| original manual RPC probe | `result: supported`, **11/11 true**; exit 0 alone is not the verdict |
| `git diff --check` | Exit 0 |

Full command logs are under [artifacts/checks](rpc-52-1-linux-postmerge/artifacts/checks/); [manifest.json](rpc-52-1-linux-postmerge/artifacts/manifest.json) retains exact product/implementation commits, source/runtime SHA-256s, command argv, runtime selection and counts. Probe artifact normalization used the existing committed normalizer: lexical prefixes (`<repo>`, `<node>`, `<fixture-root>`, validation-temp label) and trailing whitespace normalization, with no ID/time/frame/argv-order changes. Retained check logs likewise replace local prefixes and trim trailing blank lines for `git diff --check`; diagnostics and results are unchanged. Source hashes cover the unchanged driver/extension/normalizer, lockfile, relevant worker/channel/host-control sources, installed Pi RPC bundle and built entry points. Artifact SHA-256s are in `SHA256SUMS` beside the artifacts.

## Cleanup and remaining gates

`foundry shutdown` targeted only this fresh disposable state root, returned exit 0 in 5,298 ms, and reported both launches not escalated and hostStopped true. The driver found no marker-owned process after shutdown; its final sweep had an empty input and empty survivors, so no fallback kill was needed. It removed only its own fixture root. Supplemental [group-cleanup.json](rpc-52-1-linux-postmerge/artifacts/group-cleanup.json) confirms zero members of either original worker group, zero marker-owned processes, original host/worker PID paths absent and fixture root absent. The owned outer validation scratch is removed after evidence retention. No unrelated temp/config/cache cleanup, real old-host shutdown or operator-host signaling occurred.

This is one faux-provider Linux RPC survival/reconnect run, not macOS acceptance, SDK acceptance, full launcher qualification, real-model acceptance or a combined worker/daemon crash exactly-once proof. Resumed traffic here is real channel heartbeats, not a claim of post-restart application-message delivery or duplicate-effect suppression. Those stronger checks retain their separate owners. Fresh independent review by the parent is still required before any PR or completion decision; no PR, watch, merge or Linear closing action is part of this handoff.
