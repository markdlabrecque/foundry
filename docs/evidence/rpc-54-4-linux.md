# Evidence: launch gate 3, explicit stop, RPC worker on Linux

Ticket: FOU-122 (build plan draft 54a). Product contract: PRD §17.2 item 3 ("Explicit stop") and §17.3. The macOS run of this gate is a separate ticket. This file records the Linux run only.

## Outcome

**Supported on Linux.** Every observation the gate lists held, in three runs from scratch in a row:

| Observation (PRD §17.2.3) | Result |
|---|---|
| With active work, `foundry factory stop alpha` ends only alpha's process groups | **Pass.** Both alpha groups are gone (leaders and children). The stop result names exactly alpha's two launches. |
| Another factory's worker stays alive until shutdown | **Pass.** beta's leader and its child are still alive after the alpha stop. `factory list` shows `alpha stopped`, `beta running`. |
| Bounded escalation with a non-detached child still running | **Pass.** Each worker had a child in its own process group that ignores SIGTERM. Pi exited on SIGTERM (code 143). The group outlived it, the host sent SIGKILL after the grace period, and the stop reports `escalated: true` for every launch. |
| Whole-instance shutdown leaves no owned worker groups | **Pass.** After `foundry shutdown` no process remains in any owned group. The Worker Host has stopped and the daemon exited 0. |

This run did not kill the daemon, and it does not count daemon-kill survival as shutdown evidence.

## Versions and environment

- Foundry at `origin/develop` `ab06392` plus this branch's probe files only. No product code changed. Built with `npm ci && npm run build`.
- Pi coding agent `1.6.0` (`pi --version`), the pinned `@earendil-works/pi-coding-agent` from the repo's `node_modules`, started by the Worker Host through its default resolution (`rpc-entry`), not `FOUNDRY_PI_BIN`.
- Node `v22.23.2`, Linux x86_64, kernel `7.2.15-1-omarchy` (Omarchy), 2026-11-25.
- Model: a faux provider registered by the probe extension as `probe/busy`. No network, no credentials, no real model.
- Stop parameters: the daemon defaults. `DEFAULT_STOP_GRACE_MS` 5000 (used for the drain wait and again between SIGTERM and SIGKILL) and `DEFAULT_STOP_KILL_WAIT_MS` 5000. Graceful (non-`--force`) stop and shutdown.

## Exact launcher

The Worker Host spawned each worker with `detached: true` (its own session and process group, `pgid == pid`). The command line was recorded from inside the worker by the probe extension (`process.execPath`, `process.argv`, `process.cwd()`). Here is alpha `hold/1` from run 3, with the worktree path shortened to `<repo>` and the temp root to `<tmp>`:

```
/home/mark/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node
  <repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js
  --mode rpc
  --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id 559e82bd-32ba-448d-b636-0f9bb8c7cd5a
  --model probe/busy
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold
  --extension <repo>/packages/extension/dist/index.js
  --extension <repo>/docs/evidence/rpc-54-4-linux/probe-extension.ts
cwd: <tmp>/home/slots/alpha/hold-1
env: FOUNDRY_FACTORY_ID, FOUNDRY_SLOT, FOUNDRY_LAUNCH_ID set by the host, plus the isolated environment below
```

The process title shows as `pi-rpc` in `ps`.

## Effective fixture

Everything lives under one fresh `mktemp -d` root, which is removed at the end of the run. The daemon, and so the host and every worker, get only `PATH` plus:

- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` under `<tmp>/user`;
- `PI_CODING_AGENT_DIR=<tmp>/agent` holding only `settings.json` `{"enableInstallTelemetry": false}`;
- `PI_OFFLINE=1`, `PI_TELEMETRY=0`;
- `FOUNDRY_HOME=<tmp>/not-this-one`, with the state root named by `--home <tmp>/home` on every command;
- Git isolated from the operator: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, a fixed fixture identity;
- `PROBE_DIR=<tmp>/probe`, where the probe tool writes its records.

Two factories, `alpha` and `beta`. Each has a local throwaway Git source and its own `worktrees.root` under the temp root. Both use the same station:

```yaml
rooms:
  eng:
    stations:
      hold:
        model: probe/busy
        isolation: worktree
        instances: 2          # alpha; beta has 1
        extensions:
          - path: <repo>/docs/evidence/rpc-54-4-linux/probe-extension.ts
            tools: [probe_hold]
production_lines:
  f:
    verify: ["true"]
    stages:
      - { id: a, station: eng.hold, writing: true }
      - { id: b, station: eng.hold, approval: true, on_rejection: a }
```

`foundry validate` accepts it, with a Tool Set of the 12 fixed tools plus `probe_hold`. The run has three workers: alpha `hold/1`, alpha `hold/2`, beta `hold/1`.

### What makes the work "active" and the child "non-detached"

`probe-extension.ts` does the following:

- It registers the faux model `probe/busy`. Each run calls `probe_hold` once and then answers `done`.
- It starts one run with `pi.sendUserMessage("hold")` 1.5 s after `session_start`, after the Foundry extension has connected.
- `probe_hold` spawns `node -e "process.on('SIGTERM', () => {}); setInterval(...)"` with `detached: false`. That child stays in the worker's process group and ignores SIGTERM. The tool then holds the run open until Pi aborts it, and it never kills the child itself.

The fixture does not use Pi's `bash` tool to start the child. Pi 1.6.0 spawns bash-tool children with `detached: true` (their own group, see `dist/core/tools/bash.js`), and its RPC SIGTERM handler kills them itself (`killTrackedDetachedChildren`). Such a child would neither stay in the worker's group nor survive Pi's graceful exit, so it could not exercise the host's escalation.

## Reproduction

```sh
npm ci && npm run build
node docs/evidence/rpc-54-4-linux/run-probe.mjs "$(mktemp -d)"
```

A run takes about 25 s. It writes `summary.json` (every observation and nine pass/fail checks) and copies `daemon.log` and `host.log` from the state root into the output directory. Whatever happens, it SIGKILLs any process group, child, host or daemon it started, and it removes the temp root.

`run-probe.mjs` starts the built daemon (`packages/daemon/dist/main.js --home <tmp>/home alpha.yaml beta.yaml`). The daemon starts the real detached Worker Host, and the host launches the three Pi workers. The script waits until all three workers have entered `probe_hold`, then drives the built CLI (`packages/cli/dist/main.js`): `factory stop alpha --json`, `factory list --json`, `shutdown --json`. It observes processes independently through `kill(-pgid, 0)`, `kill(pid, 0)` and `ps -eo pid,pgid,ppid,args`, and reads the host's inventory over its socket.

## Observations (run 3)

Before the stop, each group held the Pi leader and its SIGTERM-ignoring child:

```
pgid 2609549  alpha hold/1  leader 2609549 (pi-rpc), child 2609651 (ppid 2609549)
pgid 2609550  alpha hold/2  leader 2609550 (pi-rpc), child 2609643 (ppid 2609550)
pgid 2609556  beta  hold/1  leader 2609556 (pi-rpc), child 2609637 (ppid 2609556)
```

`foundry factory stop alpha --json`, started 11:08:50.187, exit 0 after 10 276 ms:

```json
{"ok":true,"result":{"factoryId":"alpha","state":"stopped","force":false,"launches":[
 {"launchId":"40ef300c-…","slotId":"hold/1","drained":false,"escalated":true},
 {"launchId":"a7a72c95-…","slotId":"hold/2","drained":false,"escalated":true}]}}
```

Timeline, from the host log and the host's launch records:

```
11:08:50.19  stop requested; alpha marked stopping; drain sent to alpha's two workers
11:08:55.2   drain grace (5 s) expires unacknowledged: the held run never settles   (drained: false)
             SIGTERM to groups 2609549 and 2609550
11:08:55.445 both Pi leaders exit, code 143, signal null: "launch ended as requested"
             children 2609651 and 2609643 ignore SIGTERM, so each group is still non-empty
~11:09:00.4  SIGKILL after the 5 s grace; both groups confirmed empty               (escalated: true)
11:09:00.46  CLI answer: alpha stopped
```

After the stop:

```
alpha groups 2609549, 2609550: gone      alpha children 2609651, 2609643: gone
beta group 2609556: alive                beta child 2609637: alive
host inventory: alpha hold/1, hold/2 gone (exit 143, requested); beta hold/1 live
ps members of owned groups: 2609556 (pi-rpc), 2609637 (beta's child) only
factory list: alpha stopped, beta running
```

`foundry shutdown --json`, started 11:09:00.722, exit 0 after 10 267 ms. Beta went through the same drain timeout, SIGTERM, Pi exit 143 at 11:09:05.968, and SIGKILL for its child. Then the host accepted shutdown at 11:09:10.982:

```json
{"ok":true,"result":{"force":false,"factories":[{"factoryId":"beta","state":"stopped","force":false,
 "launches":[{"launchId":"a20d0d48-…","slotId":"hold/1","drained":false,"escalated":true}]}],"hostStopped":true}}
```

After shutdown: all three groups `kill(-pgid, 0)` → ESRCH, and all three children → ESRCH. `ps` shows no member of any owned group, the Worker Host pid is gone, and the daemon exited 0.

Checks in `summary.json`, all `true` in runs 1, 2 and 3: `childrenInWorkerGroups`, `stopSucceeded`, `stopNamedOnlyAlpha`, `escalatedEveryAlphaLaunch`, `alphaGroupsGone`, `betaSurvivesBeforeShutdown`, `shutdownSucceeded`, `noOwnedGroupsAfterShutdown`, `hostAndDaemonGone`. After each run, `pgrep` found no leftover probe or `pi-rpc` process.

## Findings that matter to Foundry

1. **Group termination reaches non-detached descendants on Linux.** Pi exits on SIGTERM, but a descendant left in its group keeps the group alive. The host's rule that "the leader reaped and `kill(-pgid, 0)` → ESRCH" is what proves a group gone held, and escalation to SIGKILL ended the descendant. The host did not report success on the leader's exit alone.
2. **Pi's own bash-tool children leave the worker's group.** They are `detached: true`, so `kill(-pgid)` on the worker's group never reaches them. Pi kills them in its SIGTERM handler, but a SIGKILL of Pi (`--force`, or escalation after Pi ignored SIGTERM) would not. This probe did not test that path. It belongs with whoever owns orphan handling, and this gate's evidence does not cover it.
3. **A held run makes a graceful stop cost the grace period twice.** The drain is answered only when Pi settles, so a stuck tool run waits out the whole drain grace and then the whole SIGTERM grace. That is about 10 s per stop with the 5 s defaults. This is the documented bound (`factory-stop.ts`), not a defect.

## Limits of this evidence

- Linux only. macOS needs its own run before RPC passes the gate (PRD §17.2: "Required on macOS and Linux").
- Faux provider only. Real-model runs and network were not exercised. The stop path does not depend on the provider.
- The drain was never acknowledged in these runs (`drained: false` everywhere), because the fixture's run never settles. A worker that acknowledges the drain was not observed here; that case is covered at the integration tier (`test/factory-stop.test.ts`), not by this gate.
- Not tested: `--force` stop or shutdown, a group the host cannot confirm gone (`stop_unconfirmed`), a stop during scheduling, detached grandchildren (see finding 2), a worker that ignores SIGTERM itself, and stops after a daemon restart.
- One machine, three consecutive runs. Process IDs, launch IDs and timestamps differ between runs; checks and outcomes did not.
