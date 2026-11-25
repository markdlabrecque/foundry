# Evidence: launch gate 3, explicit stop, RPC worker on Linux

Ticket: FOU-122 (build plan draft 54a). Product contract: PRD §17.2 item 3 ("Explicit stop"). Nothing in PRD §17.3 is exercised here. The macOS run of this gate is a separate ticket. This file records the Linux run only.

## Outcome

**Supported on Linux.** Every observation the gate lists held, in three consecutive runs from scratch (runs 5, 6 and 7 below), with all 13 probe checks `true` in each:

| Observation (PRD §17.2 item 3) | Result |
|---|---|
| With active work, `foundry factory stop alpha` ends only alpha's process groups | **Pass.** Both alpha groups are empty afterwards, leaders and children. The stop result names exactly alpha's two launches. |
| Another factory's worker stays alive until shutdown | **Pass.** beta's leader and its child are still alive after the alpha stop. `factory list` shows `alpha stopped`, `beta running`. |
| Bounded escalation with a non-detached child still running | **Pass.** Each worker had a SIGTERM-ignoring child in the worker's own process group (spawned `detached: false`). Sampling during the stop saw each Pi leader exit on SIGTERM (code 143) while its child stayed alive in the group. The group emptied only after the second grace period, and the stop reports `escalated: true` for every launch. |
| Whole-instance shutdown leaves no owned worker groups | **Pass.** After `foundry shutdown` no process remains in any owned group, no process of the run is left at all, the Worker Host has stopped and the daemon exited 0. |

This run did not kill the daemon, and it does not count daemon-kill survival as shutdown evidence.

## Versions and environment

- Foundry at commit `c3a28c8`: `develop` at `bc83e3b` plus this branch's probe files only. No product code changed. Built with `npm ci && npm run build`.
- Pi coding agent `1.6.0` (`pi --version`), the pinned `@earendil-works/pi-coding-agent` from the repo's `node_modules`, started by the Worker Host through its default resolution (`rpc-entry`), not `FOUNDRY_PI_BIN`.
- Node `v22.23.2`, Linux x86_64, kernel `7.2.15-1-omarchy` (Omarchy), 2026-11-25.
- Model: a faux provider registered by the probe extension as `probe/busy`. No network, no credentials, no real model.
- Stop parameters: the daemon defaults. `DEFAULT_STOP_GRACE_MS` 5000 (used for the drain wait and again between SIGTERM and SIGKILL) and `DEFAULT_STOP_KILL_WAIT_MS` 5000. Graceful (non-`--force`) stop and shutdown.

## Exact launcher

The Worker Host spawned each worker with `detached: true` (its own session and process group, `pgid == pid`). The probe extension recorded the command line from inside the worker (`process.execPath`, `process.argv`, `process.cwd()`). Here is alpha `hold/1` from run 7, with the worktree path shortened to `<repo>` and the temp root to `<tmp>`:

```
/home/mark/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node
  <repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js
  --mode rpc
  --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id 1539e632-4d07-4f60-a6dd-5a1fac13bc9a
  --model probe/busy
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold
  --extension <repo>/packages/extension/dist/index.js
  --extension <repo>/docs/evidence/rpc-54-4-linux/probe-extension.ts
cwd: <tmp>/home/slots/alpha/hold-1
```

Environment: the host passes its own full, unfiltered environment (the daemon's, see the fixture below) and sets `FOUNDRY_FACTORY_ID`, `FOUNDRY_SLOT` and `FOUNDRY_LAUNCH_ID`. `rpc-entry` also adds `PI_CODING_AGENT` and `AI_AGENT` inside the process. The process title shows as `pi-rpc` in `ps`.

## Effective fixture

Everything lives under one fresh `mktemp -d` root, which is removed at the end of the run. The daemon, and so the host and every worker, get only `PATH` plus:

- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` under `<tmp>/user`;
- `PI_CODING_AGENT_DIR=<tmp>/agent` holding only `settings.json` `{"enableInstallTelemetry": false}`;
- `PI_OFFLINE=1`, `PI_TELEMETRY=0`;
- `FOUNDRY_HOME=<tmp>/not-this-one`, with the state root named by `--home <tmp>/home` on every command;
- Git isolated from the operator: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, a fixed fixture identity;
- `PROBE_DIR=<tmp>/probe`, where the probe tool writes its records. It also marks every process of the run for cleanup.

Two factories, `alpha` (2 instances) and `beta` (1 instance). Each has its own throwaway local Git source (`<tmp>/repo-<name>`, one commit on `main`) and its own worktree root. The probe writes each YAML as run into its output directory. Here is `alpha.yaml` from run 7; `beta.yaml` differs only in `name`, `repo-beta`, `worktrees-beta` and `instances: 1`:

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
          - path: "<repo>/docs/evidence/rpc-54-4-linux/probe-extension.ts"
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

`foundry validate` accepts it, with a Tool Set of the 12 fixed tools plus `probe_hold`. The run has three workers: alpha `hold/1`, alpha `hold/2`, beta `hold/1`.

### What makes the work "active" and the child "non-detached"

`probe-extension.ts` does the following:

- It registers the faux model `probe/busy`. Each run calls `probe_hold` once and then answers `done`.
- It starts one run with `pi.sendUserMessage("hold")` 1.5 s after `session_start`, after the Foundry extension has connected.
- `probe_hold` spawns `node -e "process.on('SIGTERM', () => {}); setInterval(...)"` with `detached: false`. That child stays in the worker's process group and ignores SIGTERM. The tool then holds the run open until Pi aborts it, and it never kills the child itself.

The fixture does not use Pi's `bash` tool to start the child. Pi 1.6.0 spawns bash-tool children with `detached: process.platform !== "win32"`, so on Linux they get their own group. Its RPC SIGTERM handler calls `killTrackedDetachedChildren()` and then shuts down with code 143. The worker loads the bundled build, where this code is in `dist/bundle/chunks/chunk-Y55SJART.js` (`killTrackedDetachedChildren`, `killProcessTree`) and `dist/bundle/chunks/chunk-KSDI5FD4.js` (`runRpcMode`'s signal handlers). The unbundled equivalents are `dist/core/tools/bash.js` and `dist/utils/shell.js`. A bash-tool child would neither stay in the worker's group nor survive Pi's graceful exit, so it could not exercise the host's escalation.

## Reproduction

Files in [`rpc-54-4-linux/`](rpc-54-4-linux/):

- `probe-extension.ts`: the station extension described above. It writes `hold-<factory>-<slot>.json` to `$PROBE_DIR` with the worker's and child's PIDs and the worker's exact launcher.
- `run-probe.mjs`: the driver. It starts the built daemon, drives the built CLI, observes the processes, writes the output and cleans up.

```sh
npm ci && npm run build
node docs/evidence/rpc-54-4-linux/run-probe.mjs "$(mktemp -d)"
```

A run takes about 25 s and is Linux only, because cleanup reads `/proc`. It writes `summary.json` (every observation and the 13 checks), `alpha.yaml` and `beta.yaml` as run, and `daemon.log` and `host.log` copied from the state root.

`run-probe.mjs` starts the built daemon (`packages/daemon/dist/main.js --home <tmp>/home alpha.yaml beta.yaml`). The daemon starts the real detached Worker Host, and the host launches the three Pi workers. The driver waits until all three workers have entered `probe_hold`, then drives the built CLI (`packages/cli/dist/main.js`): `factory stop alpha --json`, `factory list --json` and `shutdown --json`. While each stop runs, it samples the members of every owned group (`ps -eo pid,pgid,ppid,stat,args`) every 250 ms, plus once more after the CLI answers, and keeps a sample whenever the membership changes. It also probes with `kill(-pgid, 0)` and `kill(pid, 0)` (signal 0 only), and reads the host's inventory over its socket.

Cleanup: every process the run starts inherits `PROBE_DIR=<tmp>/probe`, a path no other process carries. In a `finally`, the driver finds live processes with that entry in `/proc/<pid>/environ` and SIGKILLs only those, repeating until none is left. That reaches the detached host and workers even when the run fails before it has learned their PIDs. It never signals a recorded PID that the kernel has since given to an unrelated process. It then removes the temp root.

Result labels: `supported` when every check is `true`. `failed` when any check is false, or when an error happens after the daemon started serving. `inconclusive` only when the run cannot get that far, for example because the daemon never starts.

## Observations (run 7)

Before the stop, each group held the Pi leader and its SIGTERM-ignoring child:

```
pgid 2647496  alpha hold/1  leader 2647496 (pi-rpc), child 2647619 (ppid 2647496)
pgid 2647497  alpha hold/2  leader 2647497 (pi-rpc), child 2647632 (ppid 2647497)
pgid 2647503  beta  hold/1  leader 2647503 (pi-rpc), child 2647618 (ppid 2647503)
```

`foundry factory stop alpha --json`, started 11:20:18.392, exit 0 after 10 280 ms:

```json
{"ok":true,"result":{"factoryId":"alpha","state":"stopped","force":false,"launches":[
 {"launchId":"2ec1d1c3-…","slotId":"hold/1","drained":false,"escalated":true},
 {"launchId":"6f20f027-…","slotId":"hold/2","drained":false,"escalated":true}]}}
```

Owned-group membership sampled during the stop (ms after the CLI started, `(pid, pgid, ppid)`):

```
+8      all six: three leaders (ppid = host) and three children (ppid = their leader)
+5460   alpha leaders gone; alpha children 2647619, 2647632 still alive in groups 2647496, 2647497,
        reparented to the user subreaper (systemd --user); beta leader and child unchanged
+10280  alpha groups empty; beta's leader and child only            (CLI answered)
```

Timeline. The lines marked *observed* come from the samples, the host log or the host's launch records. The lines marked *inferred* follow from the code and the observed results; the host does not log SIGTERM or SIGKILL.

```
11:20:18.39  observed  stop requested
             inferred  alpha marked stopping; drain sent to both alpha workers (factory-stop.ts)
~11:20:23.4  inferred  drain grace (5 s) expires unacknowledged, because the held run never settles
                       (drained: false); host sends SIGTERM to groups 2647496 and 2647497
11:20:23.641 observed  both Pi leaders exit, code 143, signal null: "launch ended as requested" (host log)
+5460 ms     observed  each child alive in its group with the leader gone (childOutlivedLeader)
~11:20:28.4  inferred  second grace expires with the group non-empty; host sends SIGKILL. escalated: true
                       means kill(-pgid, 0) still found a process after the grace (terminate.ts)
+10280 ms    observed  both groups empty; CLI answers: alpha stopped
```

After the stop:

```
alpha groups 2647496, 2647497: gone      alpha children 2647619, 2647632: gone
beta group 2647503: alive                beta child 2647618: alive
host inventory: alpha hold/1, hold/2 gone (exit 143, requested); beta hold/1 live
factory list: alpha stopped, beta running
```

`foundry shutdown --json`, started 11:20:28.931, exit 0 after 10 282 ms. Beta followed the same pattern, sampled the same way: leader gone with the child alive in its group at +5479 ms (Pi exit 143 at 11:20:34.177 in the host log), group empty at +10 282 ms. The host accepted shutdown at 11:20:39.192:

```json
{"ok":true,"result":{"force":false,"factories":[{"factoryId":"beta","state":"stopped","force":false,
 "launches":[{"launchId":"aa312250-…","slotId":"hold/1","drained":false,"escalated":true}]}],"hostStopped":true}}
```

After shutdown, all three groups and all three children return ESRCH to signal 0, `ps` shows no member of any owned group, no process carries the run's marker, the Worker Host PID is gone and the daemon exited 0.

Checks in `summary.json`, all `true` in runs 5, 6 and 7:

- `fixtureShape`: two alpha launches, one beta launch, and a recorded child for each.
- `childrenInWorkerGroups`
- `stopSucceeded`
- `stopNamedOnlyAlpha`
- `escalatedEveryAlphaLaunch`
- `alphaChildOutlivedLeader`
- `alphaGroupsGone`
- `betaSurvivesBeforeShutdown`
- `shutdownSucceeded`
- `betaChildOutlivedLeader`
- `noOwnedGroupsAfterShutdown`
- `hostAndDaemonGone`
- `noRunProcessLeft`

The checks that count members first confirm their set has the expected size, so none of them can pass on an empty set.

## Findings that matter to Foundry

1. **Group termination reaches non-detached descendants on Linux.** Pi exits on SIGTERM, but a descendant left in its group keeps the group alive. The host proves a group gone only when the leader has been reaped and `kill(-pgid, 0)` returns ESRCH. That rule held: the host did not report success on the leader's exit alone, and escalating to SIGKILL ended the descendant.
2. **Pi's own bash-tool children leave the worker's group.** They are spawned detached, so `kill(-pgid)` on the worker's group never reaches them. Pi kills them in its SIGTERM handler, but a SIGKILL of Pi (`--force`, or escalation after Pi itself ignored SIGTERM) would not. This probe did not test that path. It belongs with whoever owns orphan handling, and this gate's evidence does not cover it.
3. **A held run makes a graceful stop cost the grace period twice.** The drain is answered only when Pi settles, so a stuck tool run waits out the whole drain grace and then the whole SIGTERM grace. That is about 10 s per stop with the 5 s defaults. This is the documented bound (`factory-stop.ts`), not a defect.

## Limits of this evidence

- Linux only. macOS needs its own run before RPC passes the gate (PRD §17.2: "Required on macOS and Linux").
- Faux provider only. Real-model runs and network were not exercised. The stop path does not depend on the provider.
- The drain was never acknowledged in these runs (`drained: false` everywhere), because the fixture's run never settles. A worker that acknowledges the drain was not observed here. That case is covered at the integration tier (`test/factory-stop.test.ts`), not by this gate.
- The SIGTERM and SIGKILL moments are inferred, not logged (see the timeline). Sampling is every 250 ms, so the observed times are upper bounds.
- Not tested: `--force` stop or shutdown, a group the host cannot confirm gone (`stop_unconfirmed`), a stop during scheduling, detached grandchildren (finding 2), a worker that ignores SIGTERM itself, and stops after a daemon restart.
- One machine, three consecutive runs. Process IDs, launch IDs and timestamps differ between runs; checks and outcomes did not. Runs 1 to 3, on the earlier probe at `ab06392`, also passed their nine checks.
