# SDK Tool Set mismatch/collision gate — Linux

FOU-153, draft 56j. PRD §17.2 resource-isolation last three bullets and §17.3.
**Verdict: blocked on the tested implementation; original passing criterion unmet.**
No product code, testkit or automated tests changed. No PR, merge or tracker edits.
Fresh independent review remains required. This report supersedes the initial
fixture-blocked verdict; that fixture is recoverable without product changes.

## Recovery and criterion outcomes

| Criterion | Current observation | Status |
| --- | --- | --- |
| Missing named tool freezes with a hold naming discrepancy and source | `dev/1` frozen, `tool_set_mismatch`; `missing: [{name: probe_absent, source: <REPO>/docs/evidence/rpc-53-3-linux/fixtures/missing.ts}]`; launch ends requested | **Verified** |
| Reserved Pi `read` collision refused with source and named mismatch hold | Frozen `tool_set_mismatch`; `replaced: [{name: read, expected: builtin:read, actual: …/fixtures/reserved.ts}]` | **Verified** |
| Agent-name collision refused with source | Actual host exits with `SDK extension load failed: …/fixtures/agent-name.ts`; standalone same-loader diagnostic identifies `Tool "agent_message" conflicts with <REPO>/packages/extension/dist/index.js` | **Verified refusal/source**, but see next row |
| All mismatch cases freeze with named discrepancy holds | Agent-name fails before hello: three exit-1 launches exhaust recovery and produce **parked_slot**, not frozen `tool_set_mismatch`; hold shows launch IDs/recovery count but not the named tool conflict | **Unmet** |
| `extensions: []` gets neither inherited extension nor its tool, with inheriting positive control | Both authenticate, cleared hello has 12 tools, inheriting hello 13. Cleared argv has neither `named.ts` nor `probe_named`, no named fixture markers. Inheriting argv/session marker has both, source `named.ts`. No holds | **Verified** |
| Pinned SDK, disposable isolation, no model/network requests, owned cleanup | All actual-host launch entries are `sdk-worker.js`; all 7 launch network markers have `fetchCalls: 0`; all owned groups disappear and roots are removed | **Verified within the fetch guard's limits below** |

The required agent-name named mismatch hold is not weakened into a generic loader
refusal. Diagnostic success, a parked hold, regression-suite success and prior RPC
evidence cannot qualify this gate. Original FOU-153 remains the owner of this
unmet outcome; no follow-up was filed. Independent remediation/design decision
would have to carry tool-conflict attribution into the required operator-visible
hold before this criterion can pass. No such product change is authorized here.

### Historical fixture correction (M1/M2)

The first branch revision used the sibling RPC probe's `probe-local/inert` model
from disposable `models.json`. SDK's intentional `modelsPath: null` does not load
that file. The retained run is now under `historic-results/`; all three attempts
failed model selection before hello. This is a **fixture error**, not a missing
SDK feature or proof of platform incapability. The earlier proposal to add SDK
`models.json` support is withdrawn.

Two earlier report claims were incorrect: historic `holdList` actually contains
`parked_slot`, not “no open holds”; `dev_1.missing.loaded.json` exists and registers
`probe_unnamed`. The extension **loaded**, but no session-start marker/hello was
reached. The historical mismatch criterion was therefore not exercised. No
historic `hold show` was captured; it is not reconstructed or invented now.

Fresh fixture recovery uses built-in `openai/gpt-4.1-mini` solely as model metadata,
with disposable `auth.json` containing exactly
`{"openai":{"type":"api_key","key":"none"}}`. `none` is deliberately fake,
not a credential. There are **no prompts, model requests or paid model use**.
The recorder replaces global `fetch` before SDK initialization with a throwing
counter; `PI_OFFLINE=1` remains enabled. No provider extension is needed, so the
cleared-extension control remains intact. Reviewer local diagnostic files informed
this recovery but were not copied as qualification evidence.

## Versions and exact launcher

Linux `7.2.15-1-omarchy`, Node `v22.23.2`, npm `10.9.8`, pinned Pi `1.6.0`.
Historical recovery probe ran on branch revision `179476b` (evidence-only original
commit), whose product/base was `050145655c76a722afc6bce70ae422397e49872c`.
That is the historical observation base, not the current integration base. Before
final PR handoff, the branch was rebased onto latest `origin/develop`
`d6a3856ed8f5c7d6f151279dd2e66c2a01ac5a69` (including the shared testkit temp-directory fix); the corrected probe and all regression
commands below were rerun on this integration base. Current `results/versions.json`
records the pre-evidence-refresh branch revision for that final probe.
Read [RPC sibling](rpc-53-3-linux.md), [SDK trial](sdk-147-trial.md) and PRD §17.2–3.
No repository `AGENTS.md` was present in the tracked source.

**Normalization:** retained JSON/log/text artifacts use distinct placeholders:
`<REPO>` = this checkout; `<NODE>` = exact Node executable (v22.23.2);
`<HOME>` = personal home prefix; `<PROBE_TMP>` = short private home-backed probe
temp parent; `<CHECK_ROOT>` = owned temporary regression-run root (including the historical shim control);
`<SYSTEM_TMP>` = system `/tmp`. No claim of literal unabridged personal paths is
made. UUIDs/PIDs, relative source paths, argv order and source attribution are
preserved. `normalize-evidence.mjs` performs these substitutions and trims trailing
blank lines; bulk successful Vitest file listings may be omitted while summaries,
errors and exit status are retained. Artifacts are not executable launcher scripts;
reproduce with the portable drivers, not placeholder argv.

Probe invocation from repository root:

```sh
npm ci
npm run build
mkdir -p "$HOME/f153"
TMPDIR="$HOME/f153" node docs/evidence/sdk-53-3-linux/run-probe.mjs docs/evidence/sdk-53-3-linux/results
# Expected exit 1 after the agent-name early failure and owned cleanup.
TMPDIR="$HOME/f153" PI_OFFLINE=1 node docs/evidence/sdk-53-3-linux/inspect-load.mjs > docs/evidence/sdk-53-3-linux/results/loader-errors.json
# Loader diagnostic exit 0 means inspection completed, not gate success.
node docs/evidence/sdk-53-3-linux/check-observations.mjs > docs/evidence/sdk-53-3-linux/results/assessment.json
# Expected exit 1: observations verified, gate still unmet.
```

Real chain: `<NODE> <REPO>/packages/daemon/dist/main.js --home <root>/home
<root>/factory.yaml`, with explicit `FOUNDRY_WORKER_RUNTIME=sdk`, starts the detached
Worker Host. Worker argv (full per-launch arrays are retained):

```
<NODE> <REPO>/packages/host/dist/sdk-worker.js
  --mode rpc --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve --session-id <conversation>
  --model openai/gpt-4.1-mini
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request[,probe_absent|,probe_named]
  --extension <REPO>/packages/extension/dist/index.js
  [--extension <REPO>/docs/evidence/rpc-53-3-linux/fixtures/<fixture>.ts]
cwd: <root>/home/slots/probe/<station>-1
```

`--mode rpc` is shared resource argv, not an RPC process: `sdk-worker.js` and process
markers prove SDK selection. Probe `FOUNDRY_PI_BIN` is absent. The regression shim
below is **not** used in the SDK probe.

## Effective fixtures, observations and retained evidence

The driver reuses the sibling RPC driver/fixtures with checked single-match splices;
no product comparison logic is copied. Full YAML and validation output are retained
per variant (all validate exit 0). All factories use local Git source `./repo`,
neutral worktree slots, required writing/approval stages, and the explicit model.

| Run order | Configured extension / YAML tools |
| --- | --- |
| missing | `missing.ts` registers `probe_unnamed`; YAML names `probe_absent` |
| reserved | `reserved.ts` registers `probe_named` and `read`; YAML names only `probe_named` |
| cleared | Factory default `named.ts` / `[probe_named]`; `inherit` keeps it, `cleared` overrides `extensions: []` |
| agent-name | `agent-name.ts` registers `probe_named` and `agent_message`; YAML names only `probe_named` |

Missing/reserved receive terminal `tool_set_mismatch` refusals, frozen-slot holds
with exact source evidence, and requested launch termination. The missing session
registry contains only the twelve fixed tools: unnamed `probe_unnamed` is not
active. Reserved's session registry attributes `read` to `reserved.ts`.

Agent-name: all three actual-host launches exit before hello with the fixture path
in the SDK extension-load error. Its loaded marker can exist, but **no session
marker** does. Early-failure capture retains actual `hold list`, JSON hold IDs and
`hold show`: parked-slot recovery count/ceiling 3, three exit-1 launches. Actual
`slot list`/`slot show` exit 1 with `Expected "normal" | "frozen"`; this secondary
management-decoding issue does not change the hold evidence. The standalone
`inspect-load.mjs` diagnostic repeats only Pi resource loading with the same two
extensions and dummy launch identity (no session creation/binding/socket dial),
showing the underlying tool name and competing Foundry source. Its first calibration
without dummy identity registered no Foundry tools; the retained final diagnostic
sets identity explicitly and observes the conflict. It is not substituted for host
freeze evidence. Stop after these complete observations/first reproducible unmet
condition; no unrelated SDK gates are exercised.

Artifacts under `sdk-53-3-linux/`:

- `results/{missing,reserved,cleared,agent-name}.json`: YAML, validation, CLI holds
  and slots, process/argv/output/registry/network markers, shutdown and cleanup.
- `results/{versions,loader-errors,assessment}.json`, `results/driver.log`.
- `historic-results/{missing,versions}.json`: corrected interpretation above.
- `checks/`: final no-shim command status/summary logs, historical launch shim text
  and historical failed e2e logs.
- `run-probe.mjs`, `record-process.mjs`, `inspect-load.mjs`,
  `check-observations.mjs`: portable minimal probe/inspection/checker sources.
  The checker checks a selected subset of recorded observations, not completeness
  of every artifact or a comprehensive fail-closed qualification contract. Its
  `selectedRecordedObservationsChecked` flag is deliberately narrow; acceptance
  also rests on the inspected retained evidence. It still exits 1 for the unmet gate.

## Isolation and cleanup

Every variant gets a separate owned `fou153-*` root with HOME, XDG directories,
agent/auth/settings directory, Foundry state and local Git repository. The sibling
allowlisted child environment excludes operator credentials/configuration and
system/global Git configuration. No `~/.pi` writes, production resources,
1Password, real secrets or real model requests. `PI_OFFLINE=1`, telemetry off.
The preload's fetch-deny counter is installed before SDK imports; all seven launches
record zero attempts. It enforces the SDK/provider fetch boundary, not a general OS
network namespace or proof about arbitrary raw sockets; none are introduced here.
The Foundry channel uses only each root's local Unix socket.

The process recorder retains PID/PGID/launch attribution. Cleanup requests only that
isolated instance's `shutdown --force`, checks `ps` members strictly within recorded
owned worker groups, waits for daemon exit, then removes only its owned root. Every
variant records `remaining: []`, `daemonExited: true`, `rootRemoved: true`.
The cleared pair were live before shutdown; this still does not qualify the separate
active-work/escalation explicit-stop gate. No unrelated caches/groups were deleted.

## Regression checks and environment accommodation (M4)

This is manual real-process wiring evidence, not a timing-dependent commit-tier test.
No cheaper unit tier can prove actual SDK loader/host attribution and process cleanup.

Historical checks had e2e failures (one missing slot assertion; a rerun failed Git
fixture creation). `checks/historic-e2e.log` and `checks/e2e-rerun.log` retain them.
Review reported `/tmp/jiti` ENOSPC from exhausted system-temp inodes and testkit's
Pi-child environment dropping outer TMPDIR. No global temp/cache deletion was done.
On this recovery, the outer-private-TMPDIR **before** control already passed all
5 tests (`checks/e2e-private-outer-before.log`); do not claim the shim causally fixed
a failure observed in this run. System `/tmp` still reported all 1,048,576 inodes used.

The earlier integration-base control used a temporary shim to execute unchanged
pinned Pi with unchanged arguments. The normalized historical shim is retained as
`checks/launch-shim.txt`, not used by final validation:

```
#!/bin/sh
export TMPDIR='<CHECK_ROOT>/t'
exec '<NODE>' '<REPO>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js' "$@"
```

The shared testkit fix subsequently landed on develop at `d6a3856`. After rebasing,
final validation runs **normal pinned Pi with `FOUNDRY_PI_BIN` unset and no shim**.
`run-checks.mjs` creates only a short owned home-backed TMPDIR, removes that override
from the command environment, runs the ordinary commands and records status in
`checks/status.json`. The merged testkit propagates TMPDIR to its Pi children.
This evidence branch changes no testkit/test configuration. The owned root is
removed after commands finish; final validation has no wrapper dependency.

```sh
node docs/evidence/sdk-53-3-linux/run-checks.mjs
node docs/evidence/sdk-53-3-linux/normalize-evidence.mjs
```

Final normal no-shim checks, integration base `d6a3856` (historical base `0501456`):

| Command | Exit / counts |
| --- | --- |
| `npm run build` | 0 |
| `npm run typecheck` | 0 |
| direct `./node_modules/.bin/oxlint` | 0, no diagnostics |
| direct `./node_modules/.bin/vitest run` | 0; **101 files, 839 tests passed** |
| separate `./node_modules/.bin/vitest run --config vitest.e2e.config.ts` | 0; **3 files, 5 tests passed** |

Check success is independent from the **unmet** agent-name named mismatch hold.
Do not mark the original passing criterion Done or merge as qualification evidence.
