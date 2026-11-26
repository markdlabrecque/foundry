# SDK Linux survival and reconnect — FOU-149 (draft 56f)

## Verdict: blocked on the tested implementation

**Original passing criterion remains unmet.** The actual SDK Worker Host and pinned
Pi are available. Two busy workers survive an abrupt daemon-only kill, retain
their original launch IDs and slots, and have no replacements. Neither reconnects
or resumes traffic. This is not intrinsic SDK incapability or platform unavailability.

Contract: PRD §17.2 gate 1 and SDK fallback. No §17.3, restoration, resource-isolation,
compaction, priming or explicit-stop qualification is claimed. Read alongside the
[RPC sibling](rpc-52-1-linux.md), [launcher decision](rpc-gate-decision.md) and
[SDK trial](sdk-147-trial.md). No evidence merge can close the original passing gate.

## Recovery disposition and review fixes

Resume this evidence task for review must-fixes; keep qualification blocked on
worker-side reconnect and a passing rerun. Do not file or close anything here.
Prior branch-only evidence showed survival/no replacement but failed reconnect.
Independent review reproduced that outcome on both SDK and RPC; it also isolated
an observation environment defect: the Pi child dropped TMPDIR and failed with
`ENOSPC` in `/tmp/jiti`. A diagnostic wrapper passed, but was not acceptable as
normal repository verification. No wrapper is used in the retained reruns.

**M1, narrowly scoped test support (not production code):**

- `packages/testkit/src/pi/launch.ts` creates an owned `tmp` beneath its existing
  disposable root and explicitly passes it to the Pi child. A caller's explicit
  fixture `env.TMPDIR` is respected, used for the root, and never deleted by the
  helper; disposal removes only the helper's child root. Normal runs use a short
  home-backed parent TMPDIR. No global cache is deleted or operator config changed.
- Two cheap subprocess-boundary regressions use a tiny Node environment witness,
  not Pi/daemon/model, to prove the child's actual `tmpdir()`, default cleanup and
  caller-owned override preservation. No second full Pi journey is added.
- The existing interrupt e2e now bounds the initial hello wait at 10 seconds and
  reports child exit/stderr instead of masking startup failure behind its 60-second
  whole-journey timeout. It does not widen any timeout or skip assertions.
- The reusable manual driver explicitly passes its own fixture `TMPDIR` too.
  Driver outputs and validation logs live on the home-backed filesystem, not the
  inode-exhausted `/tmp` filesystem.

**M2, evidence normalization:** all retained report/YAML/summary/log paths use
`<repo>`, `<node>` and `<fixture-root>` consistently. `<node>` denotes the exact
Node executable (Node version below); `<fixture-root>/validation-temp` denotes the
separate owned short parent used for validation/output. These are lexical labels,
not runnable paths. Argv ordering, relative resources, launch IDs, PIDs, timestamps,
socket evidence and errors are unchanged. The retained normalization driver is
[sdk-52-1-linux/normalize-artifacts.py](sdk-52-1-linux/normalize-artifacts.py).
Trailing blank lines and bulk successful test output were removed; check logs retain
command summaries/counts/times. Latest explicit-temp runs supersede earlier artifacts.

**Cheap probe hardening:** the RPC entry defaults explicitly to RPC, ignoring
ambient `FOUNDRY_WORKER_RUNTIME`; the SDK wrapper passes an explicit import runtime
parameter, which sets the child's `FOUNDRY_WORKER_RUNTIME=sdk`. Selected runtime is
prominent in summary/versions. On exceptions the driver records the failure phase
and completed checks; a completed product failure remains blocked even if a later
observer fails. An error without completed product-failure evidence is inconclusive.
The probe is not a general shared-harness or product refactor.

## Reproduction and retained artifacts

Use a short owned home-backed directory (substitute your home; no wrapper/overrides):

```sh
scratch=$(mktemp -d "$HOME/.f149-XXXX")
export TMPDIR="$scratch"
unset FOUNDRY_PI_BIN
npm ci
npm run build
npm run typecheck
./node_modules/.bin/oxlint
npm test
npm run test:e2e
node docs/evidence/sdk-52-1-linux/run-probe.mjs "$scratch/sdk-probe"
# Deliberately conflicting ambient selector proves the RPC entry is explicit:
FOUNDRY_WORKER_RUNTIME=sdk node docs/evidence/rpc-52-1-linux/run-probe.mjs "$scratch/rpc-probe"
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$scratch/sdk-probe" /path/to/retained-sdk
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$scratch/rpc-probe" /path/to/retained-rpc
# Remove only your owned scratch after retaining output and checking cleanup.
```

This is manual real-process wiring evidence, not a timing-dependent commit test.
The SDK wrapper reuses the sibling's existing busy faux-provider fixture and actual
host/daemon wiring, without copying product logic. Its exit 0 means observation
completed; use `summary.json.result` for the gate verdict.

Retained [artifacts](sdk-52-1-linux/artifacts/): SDK `summary.json`, `alpha.yaml`,
`daemon.log`, `host.log`, `group-cleanup.json`; the same five files under
`rpc-control/` for the explicit RPC control; regression summaries under `checks/`.
No operator state, production resources, secrets, 1Password or paid models were used.

## Versions, exact launcher and effective fixture

Rerun 2026-11-26, Foundry revision `1601ef60c80f7fda00510502c84f104be7967779`
(base `050145655c76a722afc6bce70ae422397e49872c`, merged SDK adapter), plus the
review fixes listed in retained `versions.uncommitted`. Node `v22.23.2`, npm
`10.9.8`, pinned repository Pi `1.6.0`, Linux x64 kernel `7.2.15-1-omarchy`.

Exact normalized daemon command, both starts:

```sh
<node> <repo>/packages/daemon/dist/main.js --home <fixture-root>/home --log-level debug <fixture-root>/alpha.yaml
```

Worker 1's exact normalized command (worker 2's full argv/session ID is in summary):

```sh
<node> <repo>/packages/host/dist/sdk-worker.js \
  --mode rpc --system-prompt '' --append-system-prompt '' \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve \
  --session-id 26c7e2bd-bdc0-46fd-abab-5aa13b709d6b --model probe/busy \
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold \
  --extension <repo>/packages/extension/dist/index.js \
  --extension <repo>/docs/evidence/rpc-52-1-linux/probe-extension.ts
# cwd: <fixture-root>/home/slots/alpha/hold-1
```

Complete argv for both workers is retained in `summary.json`.
`--mode rpc` is compatible host argument syntax: the executable
is the actual SDK adapter, with no stdin RPC command server. `FOUNDRY_PI_BIN` is
absent. The RPC control instead records pinned `bundle/rpc-entry.js` explicitly.

The allowlist contains PATH plus disposable HOME, all XDG locations,
PI_CODING_AGENT_DIR, fixture `TMPDIR=<fixture-root>/tmp`, Git isolation, offline and
telemetry settings, marker, and explicit runtime. The factory YAML has two
`eng.hold` instances, worktree isolation, neutral cwd, a disposable one-commit repo,
explicit `probe/busy` credential-free faux provider, and the configured sibling
extension naming `probe_hold`. Its actual model calls that tool and stays blocked
until abort, recording exact launch/argv. No skill or ambient provider is needed.
Fixture commits disable Git hooks. No real `~/.pi` or global config is touched.

## Observations and controls

| Observation | SDK result |
|---|---|
| Positive observer control | Both original launches accepted, each with receipt and heartbeat before kill, both busy inside actual `probe_hold` calls. |
| Original `hold/1` | `e21cae29-1029-492b-a311-139689f829e3`, PID/PGID `2651655` |
| Original `hold/2` | `4fa3fc63-bb24-42c0-bbb8-b436033ce4f7`, PID/PGID `2651662` |
| Abrupt daemon-only kill | Observed SIGKILL exit; host and original worker PIDs survive. |
| Negative connection control | Original daemon sockets disappear after kill; each worker's three host sockets remain. |
| Restart/survival | Same host PID `2651643`, host ID `c74ddf8a-fc7c-4a6f-87d5-9e837f3cf3ad`; both original workers remain live. |
| Identity and replacement | Exactly two original live launches in original slots; no replacements, changed busy records or holds. |
| Reconnect after 45,046 ms | **Failed:** zero accepted/refused channels; no worker socket to new daemon. |
| Resumed traffic | **Failed:** zero frames/heartbeats from either launch after restart. |
| Cleanup | Disposable shutdown exit 0; host/daemon stopped; no marked processes; both original worker PGIDs independently `ESRCH`. |

The explicit RPC control also observed 45,046 ms with the same nine passing and
two failing checks. Its original launches are `8e1d38af-f388-4ca7-85af-0159a908f979`
and `f3dd5ada-e9d4-48cd-a52d-9205eea97cb7`; PGIDs `2663002` and `2663009`, both
subsequently `ESRCH`. Neither rerun encountered an observation error. Full controls,
commands and timings are retained separately for each runtime. Both fixture roots
were removed after marked cleanup; no unmarked process was signaled.

## Diagnosis, regression checks and handoff

The shared `packages/extension/src/worker.ts` still dials once on session start;
its channel-close callback clears the reference but does not redial. SDK uses the
same extension. Separate remediation must add worker-side reconnect/reconciliation
for the same launch and conversation and rerun this gate. Normal-looking stranded
slots may separately need reachability reporting. Neither product change is made.

Final fetch/rebase advanced the branch base to
`6dc2a5b5f01b9be13d465bccecedc67f04e8410c` (concurrent SDK explicit-stop evidence;
no production or shared test-support changes). The manual probes above ran before
that evidence-only rebase; the complete normal command suite below was rerun after
it. Normal commands used a short home-backed TMPDIR, **without any Pi diagnostic wrapper**:

| Check | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| Direct `./node_modules/.bin/oxlint` | exit 0, empty diagnostics |
| Targeted child-temp regression | 2 tests / 1 file passed |
| `npm test` (full Vitest) | exit 0, **839 tests / 101 files passed** |
| Separate `npm run test:e2e` | exit 0, **5 tests / 3 files passed** |

The earlier `/tmp` inode-exhaustion failures are not product qualification failures
or passing checks. Review isolated dropped child temp env as their cause; normal
commands now pass with the narrow test-support repair. Regression health does not
change the independently blocked SDK/RPC gate result.

Per criterion: unchanged IDs/no replacement **verified**; reconnect/resumed traffic
**unmet**; full passing criterion **unmet**. Other gates/macOS **unverified**, outside
scope. No worker-exit restoration, execution replay, real-model or child-escalation
claim is made. Fresh independent review is required for these shared support fixes.
No PR, merge, tracker changes or product reconnect remedy. Keep the ticket open.
