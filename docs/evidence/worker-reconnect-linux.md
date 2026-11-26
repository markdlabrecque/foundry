# Worker reconnect candidate — FOU-162

## Historical candidate: positive probes, subsequently found incomplete

**Review follow-up:** fresh independent review of `71e13a6` confirmed the positive
probes but found a P1: an actual Pi `session.reload()` cleared terminal refusal
for the same launch. The implementation below is historical, not the current
complete candidate. See [the reload correction and fresh reruns](worker-reconnect-reload-linux.md)
for rebased implementation `8505ae6` and current validation. All artifacts below retain
their original provenance unchanged.

Implementation `d24ad90554084039e8632bc0847b76d8be660698`, based on fetched
`origin/develop` `43f703492834f9a2b558718094c737cfb0166da7`. Both actual-process
runs used that clean implementation commit, before this evidence-only addition.
No SDK/host loader, daemon diagnostics, host-collision policy or runtime-selector
code was changed. No migration or operator configuration change is required.

This is **candidate implementation evidence**, not product-gate closure. The
historical failed [RPC](rpc-52-1-linux.md) and [SDK](sdk-52-1-linux.md) reports and
their artifacts are unchanged. FOU-83, FOU-149 and FOU-124 remain open; their
post-merge acceptance journeys remain owned by those tickets. In particular,
FOU-124 still needs its stronger successful-continuation/no-lost-work/no-duplicate-
committed-effects journey. The small socket replay control below does not replace
that proof. No macOS claim is made; the FOU-145 Mac evidence waiver is not a pass.
Fresh independent GPT 6.1 SOL review and CI remain required before merge.

## Implementation and cheap proof

`packages/extension/src/channel/lifecycle.ts` owns one generation of transport
and its retry timer. Initial unavailability, retryable hello refusal and accepted
channel loss retry automatically. Delays are 250, 500, 1000, 2000, 4000 then
5000 ms (the existing protocol cap); successful acceptance resets backoff.
There is no configurable policy. Session events replace the active generation,
cancel its timer, abort its pending socket and close its channel before dialing.
Shutdown is final for that extension instance. A terminal hello refusal latches
for the launch and still reaches the unchanged tool client's explicit-reason /
commit-uncertainty behavior. Late acceptance is closed; stale frames cannot
reach the handlers. An unanswered hello is bounded by the existing 15 s
channel-loss constant; cancellation destroys the socket and stops heartbeats.

Each attempt builds a fresh hello from current session/history/registered tools,
with immutable factory/slot/launch identity. Session/reload starts re-announce
even on a live connection, so changed conversations are not disguised and the
existing daemon freeze and expected Tool Set policies still apply. No stdin
Foundry traffic, worker replacement, session replay or host ownership changes.

The existing adapter, message receiver, injection/receipt/compaction reporters,
interrupter and tool-call client survive transport replacement. All reattach on
acceptance. Two narrowly fixed races let receipt/compaction queues flush if an
old write fails *after* a replacement channel attached; neither spins on a dying
channel. Existing reconciliation and committed-result deduplication stay in use.

Cheapest-tier evidence:

- `packages/extension/test/reconnect.test.ts`: **9 deterministic unit cases**,
  with controlled time/dial outcomes, for bounded exponential retries, automatic
  retryable recovery, terminal latch, shutdown, cancelled/late dials and frames,
  fresh observations, and the two reporter races. No sockets, Pi or sleeps.
- Red: the initial retry test first failed (`expected +0 to be 1`) against an
  hand-extracted one-dial baseline matching the old worker's lack of retry,
  **not the untouched base implementation**. The
  [retained baseline](worker-reconnect-linux/checks/red-baseline.ts.txt) and
  [failure log](worker-reconnect-linux/checks/red.log) make the exact scope of
  this red observation explicit; it was not a new 45-second process run.
  Green: the same assertion and the additional cases pass with the lifecycle.
- `test/worker-refusal.test.ts`: one new real Unix-socket/Pi wiring journey.
  An authenticated tool call commits, the server drops the connection before
  its result reaches Pi, the extension reconnects automatically, the same call
  ID gets the stored result, and the commit counter stays **1** across **2**
  dispatches. The known prime is reconciled as `history`, not reinjected.
  This is an event-driven boundary check, with no sleep/polling assertion.
- `test/channel.test.ts`: an additional cancellation control on that existing
  socket boundary closes a pending hello, rejects it, and rejects a pre-aborted
  attempt even if the server's original claim finishes late.
- Existing terminal-tool refusal, tool-call uncertainty/replay, conversation
  freeze, Tool Set, receipt, compaction and reconciliation suites remain intact.
  In-process Pi fixtures now explicitly emit shutdown before disposal so a
  deliberately unreachable peer does not leave a reconnect timer behind.

To replay only the red observation, use a disposable checkout of the candidate,
replace `packages/extension/src/channel/lifecycle.ts` with the retained baseline,
and run `npx vitest run packages/extension/test/reconnect.test.ts -t 'initial transport unavailability'`.
Restore the implementation before running the green suite. The baseline is
historical evidence, not another production implementation or a shipped fixture.

## Exact existing probes and environment

Read the committed reports/entry points before running; no new omnibus driver
was introduced. Commands run from the repo root (the parent scratch was private,
mode 0700, under the user's home, not `/tmp`):

```sh
export TMPDIR="$HOME/f162-tmp"  # this run's freshly created, marked private parent
unset FOUNDRY_PI_BIN
npm run build
npm run typecheck
./node_modules/.bin/oxlint
npm test
npm run test:e2e
# Intentionally conflicting ambient runtime: RPC entry still selects rpc.
FOUNDRY_WORKER_RUNTIME=sdk node docs/evidence/rpc-52-1-linux/run-probe.mjs "$TMPDIR/rpc-probe"
node docs/evidence/sdk-52-1-linux/run-probe.mjs "$TMPDIR/sdk-probe"
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$TMPDIR/rpc-probe" docs/evidence/worker-reconnect-linux/rpc
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$TMPDIR/sdk-probe" docs/evidence/worker-reconnect-linux/sdk
```

The SDK entry imports the same driver with `?runtime=sdk`, explicitly setting
`FOUNDRY_WORKER_RUNTIME=sdk` in its child environment. The actual RPC worker
entry is `<repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js`;
the actual SDK entry is `<repo>/packages/host/dist/sdk-worker.js`.
Full exact argv, session IDs and neutral slot cwd for both workers are in each
summary's `before kill.holds`. SDK's `--mode rpc` is compatible host argv syntax,
not an stdin RPC command server. Both daemon invocations are:

```sh
<node> <repo>/packages/daemon/dist/main.js --home <fixture-root>/home --log-level debug <fixture-root>/alpha.yaml
```

Node `v22.23.2`, npm `10.9.8`, pinned repository Pi `1.6.0`, Linux x64,
kernel `7.2.15-1-omarchy`; both summaries have `versions.uncommitted: []`.
Both use the existing `probe/busy` credential-free faux model and `probe_hold`
extension, two worktree-isolated slots and disposable single-commit Git source.
The driver forwards only PATH from the operator environment and constructs
private HOME/XDG/Pi dirs, explicit child TMPDIR, Git isolation, PI_OFFLINE and
telemetry settings, marker and exact runtime. No paid models, real credentials,
1Password, production, operator state or global settings were used.

## Actual-process observations

All **11 checks are true for each runtime**; both `summary.json.result` values
are `supported`. This is a positive verdict from the checks, not merely driver
exit 0. Machine path prefixes are normalized with the unchanged sibling script:
`<repo>`, `<node>`, `<fixture-root>` and `<fixture-root>/validation-temp` are
lexical provenance labels, not executable paths. IDs, PIDs, argv order,
timestamps, frame counts and errors are unchanged.

### RPC — 2026-11-26 02:05 UTC

[Summary](worker-reconnect-linux/rpc/summary.json),
[daemon log](worker-reconnect-linux/rpc/daemon.log),
[host log](worker-reconnect-linux/rpc/host.log),
[YAML](worker-reconnect-linux/rpc/alpha.yaml),
[group cleanup](worker-reconnect-linux/rpc/group-cleanup.json).

- Host PID **2952471**, ID `5eb4a65a-b361-44ad-98e6-c932bdf8fa8a`, unchanged.
- `hold/1`: launch `d9734b75-2fa0-4013-a23d-06c44e85441f`, PID/PGID **2952483**.
- `hold/2`: launch `ecbf9954-8d4d-4483-ba0f-d5dbcc8ab14a`, PID/PGID **2952489**.
- Daemon **2952447** killed with SIGKILL at `02:05:36.864Z`; both busy workers
  and host survive. Their old daemon sockets disappear; host sockets remain.
- Restarted daemon **2952977** serves at `02:05:39.145Z`. Original launches
  authenticate at `02:05:40.625Z` / `02:05:40.627Z`; each sends **2 heartbeats**
  by `02:05:50.634Z`. Observation completes after **12,011 ms**.
- Exactly the original live launch inventory and slot bindings, unchanged busy
  hold records, no holds, **zero replacement launches**. Each worker has a new
  socket whose peer is the new daemon, alongside its unchanged host sockets.

### SDK — 2026-11-26 02:06 UTC

[Summary](worker-reconnect-linux/sdk/summary.json),
[daemon log](worker-reconnect-linux/sdk/daemon.log),
[host log](worker-reconnect-linux/sdk/host.log),
[YAML](worker-reconnect-linux/sdk/alpha.yaml),
[group cleanup](worker-reconnect-linux/sdk/group-cleanup.json).

- Host PID **2954000**, ID `ad373807-fba9-4a94-9c7c-2cb1c6bc4149`, unchanged.
- `hold/1`: launch `faf742d5-5930-4f6b-b181-88a9fe103e7e`, PID/PGID **2954013**.
- `hold/2`: launch `b2273bce-6710-4cf8-9965-c27ed412a909`, PID/PGID **2954019**.
- Daemon **2953970** killed with SIGKILL at `02:06:21.059Z`; both busy workers
  and host survive, with the same socket disappearance control.
- Restarted daemon **2954505** serves at `02:06:23.366Z`. Original launches
  authenticate at `02:06:24.820Z` / `02:06:24.822Z`; each sends **2 heartbeats**
  by `02:06:34.830Z`. Observation completes after **12,011 ms**.
- Same positive identity/slot/socket/busy-record controls and **zero replacements**.

Both use the fixed existing 45 s observation ceiling; neither needed it widened.
Both shutdown commands exit **0**, daemon exits **0**, host stops, and no marked
process remains before the driver's owned sweep (so none required forced sweep).
The driver removes only its owned fixture root. Independent signal-0 probes of
all four original PGIDs return **ESRCH**; both roots are absent. Those additional
read-only observations are retained in `group-cleanup.json`. Busy runs did not
drain (`drained: false`, `escalated: false`), not a graceful-drain claim.

## Normal validation and criterion disposition

No diagnostic Pi shim; `FOUNDRY_PI_BIN` unset. All subprocess fixture temp paths
are explicitly propagated through the existing repaired testkit/driver. No
timeouts widened, assertions weakened, tests skipped or ambient caches deleted.
Final normal check summaries are in [checks](worker-reconnect-linux/checks/).

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| Direct `./node_modules/.bin/oxlint` | exit 0, no diagnostics |
| Full `npm test` | **856 tests / 103 files passed** |
| Separate `npm run test:e2e` | **5 tests / 3 files passed** |
| `git diff --check` | exit 0 |

Per FOU-162 criterion: automatic initial/lost-channel recovery and bounded retries
**proved at unit tier**, actual reconnect **observed on RPC and SDK**; retryable,
terminal, shutdown and late-completion behavior **proved at controlled tier**;
fresh observations, retained reconciliation and the two reporter races **proved**;
original workers/identity/no replacements/authenticated traffic **positively
observed**; normal checks **passed**. Launch tools' terminal reason and uncertain
commit behavior remain covered by existing tests.

Limits: one Linux machine, faux models, daemon-only kill, busy channel traffic
rather than a full assignment continuation, no reboot/host-loss/macOS/paid-model
qualification. Existing 52-1 probes do not prove FOU-124's full crash-durability
contract. No PR, tracker closure, merge or coordinator CURRENT.md update here.
