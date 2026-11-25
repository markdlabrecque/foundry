# Evidence: RPC explicit stop on macOS (launch gate 3)

Ticket: FOU-128 (build plan ticket 54, macOS half; draft 54b). Product contract: PRD §17.2 gate 3 ("Explicit stop") and §17.3. The Linux half is FOU-122 (`docs/evidence/rpc-54-4-linux.md`).

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
- Pi coding agent `1.6.0` and `@earendil-works/pi-ai` `1.6.0`, as pinned in `packages/host`, `packages/extension` and `packages/testkit`.
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

  The cwd is the neutral slot folder, and `FOUNDRY_FACTORY_ID`, `FOUNDRY_SLOT` and `FOUNDRY_LAUNCH_ID` are set (`packages/host/src/launch-command.ts`).
- **Stop:** `foundry factory stop <name> [--force]` drains, then calls `terminateGroup` (`packages/host/src/terminate.ts`). That sends SIGTERM to `-pgid`, waits `graceMs` (default 5000 ms), sends SIGKILL, then waits up to `killWaitMs` (default 5000 ms). A group counts as gone only once the leader is reaped and `kill(-pgid, 0)` reports `ESRCH`.
- **Shutdown:** `foundry shutdown [--force]` stops every factory as above, then the Worker Host, then the daemon.

## What a macOS run must record to close the gate

Run on macOS with a faux provider (PRD §17.2) and disposable fixtures only: a fresh `mktemp -d` state root passed as `--home`, an isolated `HOME`, `PI_CODING_AGENT_DIR` and `XDG_*`, and no operator `~/.pi` or `~/.foundry`.

1. The macOS version and architecture, `node --version`, `pi --version` and the Foundry commit.
2. The exact launcher, as above, and the effective fixture: two factories, each with at least one active worker, and the YAML used.
3. Before the stop: each worker's launch ID, PID and PGID (`ps -o pid,pgid,command`).
4. `foundry factory stop <A>`: every group of A is gone (`kill -0 -<pgid>` → `ESRCH`), and B's group is alive with the same launch ID.
5. Escalation: a worker of A has a child that ignores SIGTERM and is spawned without `detached`, so it shares the worker's group. Show SIGTERM, the grace period, then SIGKILL (`escalated: true`), with the child gone too.
6. `foundry shutdown`: no group from the run's launches remains and the Worker Host has exited.
7. A result of supported, blocked on the tested approaches, or inconclusive, with the limits.

## Limits of this evidence

- Nothing was run on macOS. This file records only the absence of evidence, plus the setup a macOS run should use.
- It says nothing about whether the RPC launcher passes or fails gate 3 on macOS.
- The Linux half of the gate is FOU-122's to record. This file makes no claim about Linux.
