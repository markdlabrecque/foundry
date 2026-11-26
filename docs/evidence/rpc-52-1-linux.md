# Evidence: launch gate 1, survival and reconnect, RPC worker on Linux

Ticket: FOU-83 (build plan draft 52a). Product contract: PRD §17.2 item 1 ("Survival and reconnect"). Nothing in PRD §17.3 is exercised here. The macOS run of this gate is a separate ticket (FOU-92). This file records the Linux run only.

## Outcome

**Blocked on the tested approach.** Survival holds and reconnect does not. In five runs, the last three consecutive at a clean commit (runs 3, 4 and 5), the two busy workers and the Worker Host outlived an abrupt `SIGKILL` of the daemon. The restarted daemon kept both original launches in their original slots and started no replacement. Neither worker ever dialled the restarted daemon: there was no `hello`, no accepted channel, no refusal and no channel frame from either launch in 45 s. The gate's "Done when" ("two unchanged launch IDs, resumed channel traffic and no replacement") is therefore **not met**. This is a reproducible failure, not an inconclusive run: the platform was available and every step ran.

| Observation (PRD §17.2 item 1) | Result |
|---|---|
| Two busy workers in distinct slots, host references and launch IDs recorded | **Pass.** alpha `hold/1` and `hold/2`, each inside a held `probe_hold` tool run, each with an accepted channel and heartbeats before the kill. |
| Kill only the daemon, abruptly | **Pass.** `SIGKILL` to the daemon process only; it exited with signal `SIGKILL`. |
| Both original workers stay alive | **Pass.** Both worker PIDs and the Worker Host PID answered signal 0 after the kill and after the restart. Same host ID and PID before and after. |
| Same launches in both slots, no replacements | **Pass.** The restarted daemon logged `slot running` for both original launch IDs. `slot list` shows both slots `normal` on the original launches with no end recorded. The host's inventory holds exactly the two original launches, both live. No new launch, no new `probe_hold` run, no hold. |
| Both workers reconnect to the restarted daemon | **Fail.** No `channel accepted` (nor `channel hello refused`) for either launch in the restarted daemon's log over the whole 45 s window. `ss` shows each worker's socket to the killed daemon gone, and no socket to the new daemon. |
| Channel traffic resumes | **Fail.** Zero channel frames from either launch after the restart. |

### Why reconnect fails

The worker side has no redial. `packages/extension/src/worker.ts` dials the daemon once, at the launch's first `session_start`. When the channel closes it only clears its reference (`opened.channel.closed.then(() => { if (channel === opened.channel) channel = undefined; })`), and nothing dials again. The module comment says so: "A general reconnect/backoff loop after a lost channel or retryable refusal remains out of scope." A failed dial is also final ("reconnecting is not part of this extension yet"). On the daemon side, the restart wiring did its part: it adopted the surviving host and both proven launches (FOU-80), and it served the channel socket at the same path for a `hello` to arrive. None did. A longer window would not change this, because no code path in the extension would dial.

This record does not change product code. Making the gate pass needs worker-side reconnect in `@foundry/extension`: on channel loss, redial `FOUNDRY_CHANNEL_SOCKET` with backoff and send a fresh `hello` for the same launch and conversation. That work is outside this ticket.

## Versions and environment

- Foundry at commit `d3770ba`: `develop` at `edf3e0e` (after FOU-85) plus this ticket's probe files only, with no uncommitted changes (each run's `versions` record shows `foundryCommit: d3770ba` and `uncommitted: []`). No product code changed. Built with `npm ci && npm run build`.
- Pi coding agent `1.6.0` (`pi --version`), the pinned `@earendil-works/pi-coding-agent` from the repo's `node_modules`, started by the Worker Host through its default resolution (`rpc-entry`), not `FOUNDRY_PI_BIN`.
- Node `v22.23.2`, Linux x86_64, kernel `7.2.15-1-omarchy` (Omarchy), 2026-11-25.
- Model: a faux provider registered by the probe extension as `probe/busy`. No network, no credentials, no real model.
- Channel timing: the protocol defaults, `HEARTBEAT_INTERVAL_MS` 5000 and `CHANNEL_LOST_AFTER_MS` 15 000. The probe watched for reconnect for 45 s (three loss windows) after the restarted daemon served.
- Daemon started with `--log-level debug`, so every channel frame is logged by type (never contents). That is the observation channel for traffic.

## Exact launcher

The Worker Host spawned each worker with `detached: true` (its own session and process group, `pgid == pid`). The probe extension recorded the command line from inside the worker. Here is alpha `hold/1` from run 5, with the worktree path shortened to `<repo>`, the temp root to `<tmp>` and the Node v22.23.2 executable to `<node>`:

```
<node>
  <repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js
  --mode rpc
  --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id e99a19f6-ca48-48e1-943d-4e8451a4e4b1
  --model probe/busy
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold
  --extension <repo>/packages/extension/dist/index.js
  --extension <repo>/docs/evidence/rpc-52-1-linux/probe-extension.ts
cwd: <tmp>/home/slots/alpha/hold-1
```

Environment: the host passes its own full environment (the daemon's, see the fixture below) and sets `FOUNDRY_FACTORY_ID`, `FOUNDRY_SLOT`, `FOUNDRY_LAUNCH_ID` and the channel socket path. The daemon was started as `node packages/daemon/dist/main.js --home <tmp>/home --log-level debug <tmp>/alpha.yaml`, both times.

## Effective fixture

Everything lives under one fresh `mktemp -d` root, which is removed at the end of the run. The daemon, and so the host and every worker, get only `PATH` plus:

- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` under `<tmp>/user`;
- `PI_CODING_AGENT_DIR=<tmp>/agent` holding only `settings.json` `{"enableInstallTelemetry": false}`;
- `PI_OFFLINE=1`, `PI_TELEMETRY=0`;
- `FOUNDRY_HOME=<tmp>/not-this-one`, with the state root named by `--home <tmp>/home` on every command;
- Git isolated from the operator: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, a fixed fixture identity;
- `PROBE_DIR=<tmp>/probe`, where the probe tool writes its records. It also marks every process of the run for cleanup.

One factory, `alpha`, with a throwaway local Git source (`<tmp>/repo-alpha`, one commit on `main`):

```yaml
version: 1
name: alpha
repository:
  source: ./repo-alpha
  default_branch: main
default_production_line: f
worktrees:
  root: "<tmp>/worktrees-alpha"
rooms:
  eng:
    stations:
      hold:
        model: probe/busy
        isolation: worktree
        instances: 2
        extensions:
          - path: "<repo>/docs/evidence/rpc-52-1-linux/probe-extension.ts"
            tools: [probe_hold]
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: a
        station: eng.hold
        writing: true
      - id: b
        station: eng.hold
        approval: true
        on_rejection: a
```

### What makes a worker "busy"

`probe-extension.ts` registers the faux model `probe/busy`, which calls `probe_hold` once per run and then answers `done`. It starts one run with `pi.sendUserMessage("hold")` 1.5 s after `session_start`, after the Foundry extension has dialled. `probe_hold` writes `hold-<factory>-<slot>.json` (launch ID, PID, exact launcher) and holds the run open until Pi aborts it. So each worker is mid-run, inside a tool call, for the whole probe. A second `probe_hold` record would mean a new run; none appeared.

## Reproduction

Files in [`rpc-52-1-linux/`](rpc-52-1-linux/):

- `probe-extension.ts`: the station extension described above.
- `run-probe.mjs`: the driver.
- `result.json`: run 5's `summary.json`, with paths shortened as above.

```sh
npm ci && npm run build
node docs/evidence/rpc-52-1-linux/run-probe.mjs "$(mktemp -d)"
```

A run takes about 60 s and is Linux only (cleanup reads `/proc`, socket evidence uses `ss`). It writes `summary.json`, `alpha.yaml` as run, and `daemon.log` and `host.log` copied from the state root.

The driver starts the built daemon, which starts the real detached Worker Host, which launches both Pi workers. Once both are inside `probe_hold` it waits 6 s for heartbeats, then records the host identity and inventory, `foundry slot list`, the channel activity per launch from the daemon log, and each worker's Unix sockets with the PID at the other end (`ss -xp`, keeping only sockets the worker alone holds). It sends `SIGKILL` to the daemon only, waits 2 s and probes the host and workers with signal 0. It starts the daemon again on the same state root and polls the daemon log written since the restart, for up to 45 s, for `channel accepted` and at least two heartbeats from each original launch. It then records the same observations plus `foundry hold list`, runs `foundry shutdown`, and checks no process of the run is left.

Cleanup is the same as `rpc-54-4-linux`: in a `finally`, the driver SIGKILLs only live processes carrying the run's `PROBE_DIR` marker in `/proc/<pid>/environ`, then removes the temp root.

Result labels: `supported` when every check is `true`. `blocked` (blocked on the tested approach, a reproducible failure) when any check is false, or an error happens after the first daemon served. `inconclusive` only when the run cannot get that far.

## Observations (run 5)

Before the kill, at 00:03:29 UTC:

```
daemon pid 2085183    Worker Host pid 2085199, hostId 76ca46b8-…, bootId e4653541-…
hold/1  launch a3792369-8a48-46d8-b58a-1b4de65362fe  pid/pgid 2085221  live, in probe_hold since 00:03:22.882
hold/2  launch a6bbcccb-bc88-48ea-9089-a5f10789b448  pid/pgid 2085222  live, in probe_hold since 00:03:22.883
slot list: hold/1 normal a3792369-…, hold/2 normal a6bbcccb-…, no end recorded
channel: each launch accepted at 00:03:21.37, then frames receipt ×1, heartbeat ×1 (last at 00:03:26.37)
sockets: each worker holds 1 socket to the daemon (2085183) and 3 to the host (2085199)
```

`SIGKILL` to pid 2085183 at 00:03:29.414. The daemon exited with signal `SIGKILL`. Two seconds later:

```
Worker Host 2085199 alive     workers 2085221, 2085222 alive
sockets: each worker's daemon socket gone; its 3 host sockets unchanged
```

The restarted daemon (pid 2085685) served at 00:03:31.698. Its log (all non-frame lines, abridged):

```
00:03:31.686  factory clone reused          alpha
00:03:31.688  factory configuration loaded  alpha (loadId 2)
00:03:31.694  slot running                  hold/1  a3792369-…
00:03:31.694  slot running                  hold/2  a6bbcccb-…
00:03:31.698  daemon started                pid 2085685
                — nothing for 45 s: no channel accepted, refused, lost or frame; no warning —
00:04:17.541  launch ended                  hold/1  (the probe's shutdown)
00:04:17.542  launch ended                  hold/2
00:04:17.553  daemon stopping               shutdown
```

At the end of the 45 042 ms window:

```
host: same pid 2085199, same hostId; inventory = exactly a3792369-… and a6bbcccb-…, both live
workers 2085221, 2085222 alive; probe_hold records unchanged (no new run, no new launch)
slot list: hold/1 normal a3792369-…, hold/2 normal a6bbcccb-…   hold list: []
channel since restart: accepted [], lost [], frames {} for both launches
sockets: each worker still holds only its 3 host sockets; none to daemon 2085685
```

Across the whole daemon log there are 4 `channel frame` lines, all from the first daemon run.

`foundry shutdown --json` exit 0 in 270 ms; both launches `drained: false, escalated: false` (Pi exits on SIGTERM, there is no child), `hostStopped: true`. Afterwards the host is gone, the daemon exited 0 and no process of the run is left.

Checks in `summary.json`, the same in runs 3, 4 and 5:

| Check | Result |
|---|---|
| `fixtureShape` | true |
| `connectedBeforeKill` | true |
| `daemonKilledAbruptly` | true |
| `workersAndHostSurviveKill` | true |
| `sameHostAfterRestart` | true |
| `workersStillAlive` | true |
| `sameLaunchesInSlots` | true |
| `noReplacement` | true |
| `reconnectedToRestartedDaemon` | **false** |
| `channelTrafficResumed` | **false** |
| `shutdownLeavesNothing` | true |

## Findings that matter to Foundry

1. **The worker extension does not reconnect.** This is the blocker. A lost channel is never redialled, so after any daemon restart every surviving worker stays alive but unreachable. That defeats the restart recovery FOU-64, FOU-80 and FOU-85 build on the daemon side: reconciliation, priming, message delivery and the FOU-85 assignment gate all start from an accepted `hello`.
2. **The stranded slots look healthy.** After the restart both slots read `normal` with no hold and no warning. The FOU-85 per-slot gate stays closed, so they take no new work, but the operator cannot see why. The `slot not taking work` warning is only raised for a connection that was accepted and then failed to reconcile, not for a launch that never connects. Separately from reconnect, a recorded live launch with no channel after a restart may deserve its own visible condition or hold.
3. **The daemon-side survival path is sound.** The host survives, ownership is proven for both launches (`slot running`), and nothing is relaunched or frozen. Once the extension redials, this gate should be re-run with this probe unchanged.

## Limits of this evidence

- Linux only. macOS needs its own run (FOU-92).
- Faux provider only. The reconnect path does not depend on the provider.
- One tested approach: the RPC launcher with the current `@foundry/extension`. The SDK fallback (PRD §17.2, "Fallback") was not tried; it would need the same worker-side reconnect.
- The reconnect window was 45 s. The conclusion rests on the code as well (no redial path exists), not on the window alone.
- Not tested: a daemon stopped gracefully (`SIGTERM`), a host killed with the daemon, a reboot, a restart during a tool call that reaches the daemon, and message delivery after a reconnect.
- One machine. Runs 1 and 2 used earlier, uncommitted versions of the driver (run 1 recorded noisy socket evidence and labelled the result `failed`) with the same checks and outcome. Runs 3, 4 and 5 ran consecutively at `d3770ba`. PIDs, launch IDs and times differ between runs; checks and outcomes did not.
