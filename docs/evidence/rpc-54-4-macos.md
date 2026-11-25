# Evidence: RPC explicit stop on macOS (launch gate 3)

Ticket: FOU-128 (build plan ticket 54, macOS half; draft 54b). Product contract: PRD §17.2 gate 3 ("Explicit stop"). The ticket also cites §17.3, but none of its checks concerns explicit stop. The Linux half is FOU-122 (`docs/evidence/rpc-54-4-linux.md`, not yet merged).

## Outcome

| Observation required by gate 3 | Outcome on macOS |
|---|---|
| A named factory stop drains or terminates only that factory's process groups | **Not observed** |
| Another factory's worker stays alive until shutdown | **Not observed** |
| Bounded escalation (SIGTERM, grace, SIGKILL) with a non-detached child still running | **Not observed** |
| Whole-instance shutdown leaves no owned worker groups | **Not observed** |

**Result: inconclusive (platform unavailable).** No part of this gate was run on macOS, so none of the observations above exists for macOS. This is **not a pass**. PRD §17.2 needs gate 3 on both macOS and Linux before Foundry relies on the RPC launcher. Ticket 55 (FOU-136, "Record the RPC gate decision") must treat macOS gate 3 as still open until a run on macOS replaces this record.

Evidence from Linux, from the integration tests or from the 2026-11-24 macOS spike (PRD §17.1) does not stand in for this gate. Process groups, `setsid`, signal delivery to groups and `ESRCH` probing are POSIX, but how they behave under Node's `detached: true` on Darwin is exactly what the gate exists to observe. It cannot be inferred.

## Why the platform was unavailable

The ticket ran unattended on a Linux workstation (agent run, 2026-11-25). An operator-owned macOS laptop was reachable over SSH. Running worker processes and temporary state on it needs the operator's explicit authorization, and nobody was there to give it, so no macOS host was used. No macOS run was attempted, and no result was simulated or carried over from another platform.

## Versions and environment of this run

Recorded so a later macOS run can be compared with the tree this record was made against.

- Foundry tree: `develop` at `bc83e3b` (after FOU-95, FOU-126, FOU-131 and FOU-138 merged).
- Pi coding agent `1.6.0`, pinned in `packages/host`, `packages/extension` and `packages/testkit`, read from the installed `node_modules/@earendil-works/pi-coding-agent/package.json`. `@earendil-works/pi-ai` `1.6.0` is pinned in `packages/testkit` only.
- Node `v22.23.2`, npm `10.9.8`.
- Host used: Linux (Omarchy, kernel 7.2.15, x86_64). **Not macOS.** No macOS version, Node build or Pi install was exercised.

## The launcher a macOS run must use

Unchanged from `develop` at `bc83e3b`. A later run records any difference.

- **Worker Host:** `startHost(stateRoot)` (`packages/host/src/client.ts`) spawns `node packages/host/dist/main.js <state-root>` with `detached: true`, stdin ignored and stderr going to the host log.
- **Worker:** the host spawns each launch (`packages/host/src/launches.ts`) with `detached: true` (its own session and process group) and stdio piped, running `node <pi-coding-agent>/rpc-entry` (or `FOUNDRY_PI_BIN`) with:

  ```
  --mode rpc --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id <conversationRef> --model <provider/model> --tools <fixed tools,…>
  --extension <foundry extension> [--extension <configured>…] [--skill <configured>…]
  ```

  The argv is built by `buildLaunchArgs` (`packages/host/src/launch-command.ts`). With the default `rpc-entry`, Pi sees `--mode rpc` twice, which is harmless. `ps` may show it once or twice; either is fine. The cwd is the neutral slot folder. The daemon sets `FOUNDRY_CHANNEL_SOCKET` in the launch spec (`packages/daemon/src/slots.ts`). At spawn time the host sets `FOUNDRY_FACTORY_ID`, `FOUNDRY_SLOT` and `FOUNDRY_LAUNCH_ID` on top of its own full environment (`packages/host/src/launches.ts`).
- **Stop:** `foundry factory stop <name>`. Without `--force`, the daemon sends `drain` to the factory's live workers and waits up to `graceMs` for acknowledgements. The host then runs `terminateGroup` (`packages/host/src/terminate.ts`) on every launch the factory owns, including launches that have already ended. That sends SIGTERM to `-pgid` and waits up to `graceMs` (default 5000 ms). SIGKILL is sent only if the group is still present after that wait (`escalated: true`), followed by a wait of up to `killWaitMs` (default 5000 ms). A group counts as gone only once the leader is reaped and `kill(-pgid, 0)` reports `ESRCH`. If it is not gone, the outcome is `unconfirmed` and the stop fails with `stop_unconfirmed`. `--force` skips the drain and SIGTERM and sends SIGKILL straight away (`graceMs: 0`), so it never exercises escalation.
- **Shutdown:** `foundry shutdown [--force]` stops every factory concurrently as above (factories already stopped are skipped). It then terminates any stray launches the host owns for factories not started in this run, then stops the Worker Host, then the daemon. If any group is unconfirmed, the result is `shutdown_unconfirmed` (exit 1) and the host is left running.

## What a macOS run must record to close the gate

Run on macOS with a faux provider (PRD §17.2) and disposable fixtures only: a fresh `mktemp -d` state root passed as `--home`, an isolated `HOME`, `PI_CODING_AGENT_DIR` and `XDG_*`, and no operator `~/.pi` or `~/.foundry`. The host passes its whole environment to workers unfiltered, so the isolated variables must be set in the environment that starts the daemon and Worker Host, not only in the environment of the `foundry` CLI calls.

1. The macOS version and architecture, the Foundry commit, the `node --version` of the Node that runs the Worker Host, and the Pi version the launcher actually runs. That version comes from `@earendil-works/pi-coding-agent/package.json` as resolved in the Foundry checkout, together with whether `FOUNDRY_PI_BIN` was set. Do not use the `pi --version` of a `pi` on PATH.
2. The exact launcher, as above, and the effective fixture: two factories, A and B, each with at least one worker mid-run on a faux-provider turn (active work, so the drain path runs), and the YAML used.
3. Before the stop: each worker's launch ID, PID and PGID (`ps -o pid,pgid,command`). In A, one worker must have a child that ignores SIGTERM and was spawned without `detached`. Record the child's PID and confirm that its PGID equals the worker's. Don't start the child through Pi's bash tool: in Pi 1.6.0 it spawns with `detached` on non-Windows platforms, so its children get their own process group. Use a fixture extension or a `FOUNDRY_PI_BIN` stub that calls `child_process.spawn` without `detached` and starts a process that ignores SIGTERM (for example `trap '' TERM`). Bash-tool children landing outside the worker's group may be a gap in "no owned worker groups" for FOU-136 to weigh. It is out of scope here.
4. A graceful `foundry factory stop A`, **without `--force`**. In that stop, record the drain, SIGTERM, the child surviving the grace period, then SIGKILL with `escalated: true` reported for that launch. Then record every group of A gone, including the child: `kill -0 -- -<pgid>` prints "No such process". B's group must still be alive with the same launch ID.
5. `foundry shutdown`: exits 0, no group from the run's launches remains, and the Worker Host has exited.
6. A result of supported, blocked on the tested approaches, or inconclusive, with the limits.

## Limits of this evidence

- Nothing was run on macOS. This file records only the absence of evidence, plus the setup a macOS run should use.
- It says nothing about whether the RPC launcher passes or fails gate 3 on macOS.
- The Linux half of the gate is FOU-122's to record. This file makes no claim about Linux.
