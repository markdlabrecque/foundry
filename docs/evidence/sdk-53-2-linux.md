# FOU-151: SDK resource isolation and named tools — Linux

[Ticket](https://linear.app/foundry-mdl/issue/FOU-151/check-sdk-resource-isolation-and-named-tools-on-linux), draft 56h. Scoped observations from PRD §17.2–3; actual Worker Host, pinned Pi, disposable resources and credential-free faux model calls. References: [RPC sibling evidence](rpc-53-2-linux.md), [SDK adapter trial](sdk-147-trial.md).

## Current outcome: supported on the tested approach

The recovered real-process run completed **all observations in this draft**. Three actual SDK workers connected: inheriting and skill-cleared workers each exposed 13 tools; the fully cleared station exposed 12 fixed tools and no configured fixture. Each configured worker's actual faux-model turn called `probe_named` and received its result; the registered-but-unnamed tool was absent.

This supersedes the previous blocked fixture approach, not the historical observations. It is **not** whole-launcher or cross-platform qualification and does not cover mismatch/collision drafts, reconnect, explicit-stop cross-factory isolation, restoration, priming or a real paid model reading an indexed skill on demand. This ticket changes no product code, SDK model registration or testkit. Fresh independent GPT-6.1-SOL re-review approved head `9dcd3f0d009ee9fd6cf874fcb13f46cf0793cf03` with no must-fixes; the reviewer independently repeated the actual SDK probe (all eight observations supported), six analyzer tests and the 843-test suite. Final integration checks after the shared temp fix are recorded separately below.

## Per-criterion evidence

The prerequisite-aware [`observations.json`](sdk-53-2-linux/observations.json), recomputed from retained output by [`summarize.mjs`](sdk-53-2-linux/summarize.mjs), verifies:

| Criterion | Observed result |
|---|---|
| Actual SDK host and pinned Pi | **Verified.** Explicit `FOUNDRY_WORKER_RUNTIME=sdk`; actual argv enters `packages/host/dist/sdk-worker.js`. All three workers authenticate on the Foundry channel. Pi 1.6.0, not the outer harness installation. |
| Ordinary global positive control | **Verified.** Ordinary pinned Pi loads `GLOBAL_EXTENSION_53A`, starts local MCP, activates global `defaultTools: [grep]`, and passes global AGENTS/SYSTEM/APPEND markers and `mcp__probe__ambient` to its faux-model request. Both configured registrations appear in its registry. |
| Effective configured model and extension | **Verified.** `session_start` identifies `probe-faux/scripted`, not conflicting `wrong-control/wrong-control`; configured extension startup and actual faux-model inputs are recorded in both configured workers. |
| Skill and cleared skill override | **Verified.** Inherited model input includes `CONFIGURED_SKILL_53A` description/path; `skillclear/1` does not. This proves indexing, not an on-demand read of its body. |
| Global extension/MCP/defaultTools/context excluded | **Verified.** With positive ordinary controls and accepted/model-request evidence present, neither configured worker loads ambient extension/MCP/context markers. Actual model tool declarations are exactly 12 fixed tools plus `probe_named`, without `grep`, `find`, MCP or unnamed fixture tools. |
| Repository resources excluded | **Verified on the neutral-cwd approach.** Disposable source contains marked root AGENTS and `.pi` extension, skill, settings and system prompt. Worker cwd is outside the repository; repository markers do not appear in worker startup/model input. No trusted ordinary repository baseline was run; do not generalize to every trust mode. |
| Named tool callable; unnamed registration absent | **Verified.** Shared fixture registers `probe_named` and `probe_unnamed`; each configured worker's first faux turn emits a real `probe_named({value:"CALL_MARKER_53A"})` call, executes it once, and includes `TOOL_RESULT_53A:CALL_MARKER_53A` in its second model request. `probe_unnamed` is absent from model declarations. No driver directly calls the implementation. Fixed tools remain available. |
| Fully cleared inheritance | **Verified.** Clear station has no configured-extension argv, no `--skill`, no configured startup marker, an accepted hello with 12 fixed tools, normal slot state, no freeze, and no prompt/model request. No inherited provider extension is retained to keep it alive. |
| Safe fixture and cleanup | **Verified.** Fake disposable auth, offline mode and deny-fetch installed in all three workers; zero fetch attempts. Three owned marked worker groups and their host are absent after owned-state shutdown, including an exact-PGID group-membership check. |

Accepted identities in the qualification capture:

| Slot | Launch ID | Tools |
|---|---|---:|
| `inherit/1` | `b2f7c7af-4e1e-40bc-9d69-bf00aff51122` | 13 |
| `skillclear/1` | `880aebc9-deaf-4dba-93b2-09516e3f2882` | 13 |
| `clear/1` | `0103d3e7-73cf-45c1-b84b-97d0678705f1` | 12 |

## Reproduction and exact fixture

This is a bounded **manual real-process integration probe**, not a timing-dependent commit-suite test. Only this boundary proves ordinary discovery, actual detached SDK host wiring and model tool round trips. It reuses the sibling harness, fixture extension and recording preload; it does not duplicate product logic.

Complete qualification invocation used:

```sh
npm run build
mkdir -p /home/mark/f151
TMPDIR=/home/mark/f151 \
  node docs/evidence/sdk-53-2-linux/run-probe.mjs /home/mark/f151/qualification
# driver exit 0 is only execution status, not independently a gate pass
node docs/evidence/sdk-53-2-linux/normalize.mjs \
  /home/mark/f151/qualification/result.json docs/evidence/sdk-53-2-linux/result.json
node docs/evidence/sdk-53-2-linux/summarize.mjs docs/evidence/sdk-53-2-linux
```

A fresh equivalent short private directory is fine. `/home/mark/f151` is disk-backed; **do not use inode-exhausted `/tmp`**. The runner creates a short uniquely owned disposable root beneath it and explicitly allowlists `TMPDIR=<root>/tmp` into **every** child (ordinary Pi, MCP, CLI, Git, daemon, host and workers). This preserves the original environment allowlist; no operator environment/credential spread was added. Ordinary discovery remains enabled. `FOUNDRY_PI_BIN` is unset for the probe.

Defaults: faux model `probe-faux/scripted`, one configured skill, configured extension object `tools: [probe_named]`. `inherit` inherits; `skillclear` sets `skills: []`; `clear` sets `skills: []`, `extensions: []`, and **only there** the idle built-in model `openai/gpt-4.1-mini`. Complete YAML and resolved validation are in `result.json`.

The approved fixture-only recovery writes disposable `auth.json` exactly as:

```json
{"openai":{"type":"api_key","key":"none"}}
```

This is intentionally fake, not a credential. It allows builtin model selection preflight while the cleared station is **never prompted**. Configured workers continue to make actual credential-free **faux** model calls. `PI_OFFLINE=1` and [`deny-network.mjs`](sdk-53-2-linux/deny-network.mjs), imported via allowlisted `NODE_OPTIONS` into all Node children, replace `fetch` with a throwing recorder before any model startup. The capture shows deny-fetch installation in every worker and **zero `fetch-denied` attempts**. This enforces the no-real-model-request boundary; it is not claimed to be a general OS-level network sandbox. The fixture never invokes socket/HTTP clients directly except the local stdio MCP fixture and Foundry's local channel.

All HOME/agent/XDG/repository/session/state/temp locations are disposable. No real `~/.pi`, operator global configuration, production, 1Password or secrets are read or changed. Fixture Git history is fresh and commits disable hooks. SDK's intentional `modelsPath: null` is unchanged. The sibling loopback `models.json` remains in the global control fixture but is not needed to start the recovered cleared SDK worker.

### Versions and captured launcher

- Product base: `050145655c76a722afc6bce70ae422397e49872c`, including merged SDK adapter.
- Capture source checkout HEAD: `5e67e08b500a287e3b6854883d22bc34f3dfaa6d`; recovery harness edits were uncommitted when observed. Product code equals the base above.
- Pi **1.6.0**, Node **v22.23.2**, npm **10.9.8**.
- `Linux omarchy 7.2.15-1-omarchy #1 SMP PREEMPT_DYNAMIC Mon, 02 Nov 2026 10:32:17 +0000 x86_64 GNU/Linux`.
- Run began `2026-11-26T01:06:44Z`. Actual owned disposable root was under the short disk-backed parent above and was removed after cleanup.

**Transformation label:** committed captures are path-normalized, not byte-for-byte raw. `/REPO` denotes the checkout, `/NODE` the pinned Node installation, `/RUN` that artifact's disposable root; irrelevant PATH search-list text is omitted. The normalization tool preserves argv/source/cwd relationships, launch IDs, marker strings, counts, model requests/results and representative errors. Private original captures remain outside Git at `/home/mark/f151/qualification/`. Checks use analogous `/CHECK_TMP` placeholders. These placeholders are substitutions, not literal runnable paths.

Inherited worker command, with those consistent path substitutions:

```sh
/NODE/bin/node /REPO/packages/host/dist/sdk-worker.js \
 --mode rpc --system-prompt '' --append-system-prompt '' \
 --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
 --no-context-files --no-approve \
 --session-id 41360fb3-03e5-4e82-a065-2365afd9f6d6 \
 --model probe-faux/scripted \
 --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_named \
 --extension /REPO/packages/extension/dist/index.js \
 --extension /REPO/docs/evidence/rpc-53-2-linux/fixture.mjs \
 --skill /RUN/skill/SKILL.md
# cwd: /RUN/state/slots/probe/inherit-1
```

`result.markers` is authoritative for the captured session ID and all argv. Host argv remains RPC-compatible for parsing; the executed entry is SDK, **not** a running RPC server. `NODE_OPTIONS` imports the sibling `record-argv.mjs` and this draft's `deny-network.mjs`; neither replaces product launch logic or registers tools. Ordinary calibration is `/NODE/bin/node /REPO/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc --model probe-faux/scripted --extension /REPO/docs/evidence/rpc-53-2-linux/fixture.mjs`, cwd `/RUN/user`.

## Review recovery and historical evidence

The previous blocker was the **fixture approach**, not a requirement for a product model-registration change. The first attempt selected an unauthenticated idle builtin; the next relied on `models.json`, which SDK intentionally does not load. These unsuccessful records and representative errors are preserved under [`history/`](sdk-53-2-linux/history/), with both original and current prerequisite-aware analysis. Neither is counted as a pass; the old analyzer's output is explicitly superseded.

Review fixes:

1. **M1:** give ordinary Pi and every child a short owned disk-backed `TMPDIR`, not just the parent. `/tmp` was confirmed at 1,048,576/1,048,576 used inodes; no unrelated global/temp cleanup was performed.
2. **M2:** pure analyzer now requires ordinary calibration, nonempty accepted-worker/model-request evidence and actual tool results before negative exclusion checks can verify. Fully cleared evidence requires an actual accepted hello and nonempty argv records. No `.every([])` can prove exclusion. An unregistered-model reason is derived only from retained errors belonging to real clear-launch IDs, never invented before launches. Missing evidence is **unverified/inconclusive**. Driver outcome/exit 0 cannot force analyzer success.
3. **Cheapest regression:** six pure unit cases in `test/sdk-resource-evidence.test.ts` cover empty/exit-zero-only records, failed calibration, missing accepted hello, missing model requests, supported observations independent of driver label, and one observed launch error without a hardcoded three-retry requirement. They launch no process and use no timing/filesystem/network.

The shared RPC harness's default five-tool expectation is **historical and not recertified** here. Only SDK's current 12/13 count is exercised. No actual RPC replay was requested for this ticket; do not interpret shared-driver updates as a current default-RPC gate pass.

## Owned cleanup

Probe shutdown targets **only** its disposable state root via `foundry shutdown --force`. Raw response: `factory probe stopped (3 worker(s))`, `worker host stopped`, `shutdown complete (forced)`. No process is selected for signaling by executable-name match.

`ownedBeforeShutdown` identifies only processes with this run's unique `PROBE_MARKER_DIR`: host PID/PGID **2663901**, workers **2663912**, **2663918**, **2663925** (each PID equals PGID), plus the foreground daemon. `ownedAfterShutdown` is empty; an exact-PGID `ps -eo pid=,pgid=,stat=,args=` filter finds **zero members** of the owned detached groups, including members that might have dropped the environment marker. The foreground daemon exited. The owned disposable root is removed only after successful cleanup. This does not qualify the separate cross-factory explicit-stop gate.

## Artifacts and regression checks

- `sdk-53-2-linux/run-probe.mjs`: SDK selector wrapper reusing the calibrated sibling harness.
- `sdk-53-2-linux/result.json`: transformed capture with versions, launch commands, YAML/validation, startup/model/tool markers, slot identities/state, network guard markers, daemon/host logs and cleanup.
- `summarize.mjs`, `summarize.d.mts`, `observations.json`: prerequisite-aware pure classification and CLI.
- `deny-network.mjs`, `normalize.mjs`: fixture-only fetch guard and labeled path transformation.
- `history/`: preserved unsuccessful records and corrected reanalysis.
- `checks/`: final normal integration logs after the shared temp fix; these are **separate** from the successful real-process observations.
- `history/pre-temp-fix-checks/`: prior integration logs, retaining the normal e2e failure and shim-assisted pass without relabeling them.

### Historical integration checks before the shared temp fix

After fetching/rebasing then-latest `origin/develop` **`6dc2a5b5f01b9be13d465bccecedc67f04e8410c`**, all checks were rerun on **`cc7ec54471f1b7f50e8c0438288e06736c43bd98`**. That develop advance adds the separate SDK explicit-stop evidence only, not product/testkit changes. The subsequent check-log/documentation commit changes no observation driver, analyzer or test code.

| Check | Exit / result |
|---|---|
| `npm run build` | **0** |
| `npm run typecheck` | **0** |
| Direct `./node_modules/.bin/oxlint` | **0**, empty diagnostics |
| `TMPDIR=/home/mark/f151 ./node_modules/.bin/vitest run` | **0**, **101 files / 843 tests passed** |
| Separate normal e2e with private parent TMPDIR | **1**, **4/5 tests passed**; interrupt child timeout |
| Separate e2e with pinned-Pi child-temp shim | **0**, **3 files / 5 tests passed** |
| Focused pure analyzer unit tests | **0**, **1 file / 6 tests passed** |

Historical commands/exits/counts are in `history/pre-temp-fix-checks/exits.json`; all corresponding logs, including the failed normal e2e, are retained. Normal e2e command: `TMPDIR=/home/mark/f151 ./node_modules/.bin/vitest run --config vitest.e2e.config.ts`. The shared testkit's isolated interrupt child deliberately omits parent TMPDIR; with `/tmp` still at zero free inodes, its Jiti startup can fail before hello. The fixture's test then times out. This is the already reproduced environment limitation, not a negative SDK verdict. No testkit fixes are made in this branch; that shared work belonged to the sibling owner and had not merged into that integration base.

Qualified e2e command: `TMPDIR=/home/mark/f151 FOUNDRY_PI_BIN=/home/mark/f151/checks/pi-temp ./node_modules/.bin/vitest run --config vitest.e2e.config.ts`. The retained historical `history/pre-temp-fix-checks/pi-temp` (path-normalized) **only exports the same private TMPDIR then execs the unchanged pinned Pi CLI with all arguments**. It was generated outside the repo with this checkout's absolute Pi path. No regression shim was used in the SDK qualification probe: that probe's own explicit allowlist now carries child TMPDIR correctly. Do not describe unqualified normal e2e as passing until the shared fix/environment is available.

At that historical head the probe's scoped result was **supported**, but normal e2e remained infrastructure-qualified. The subsequent independent re-review approved the narrow evidence with no must-fixes; normal checks were rerun only after the shared fix merged, below.

### Final normal integration checks after the shared temp fix

Fetched and rebased onto `origin/develop` **`d6a3856ed8f5c7d6f151279dd2e66c2a01ac5a69`**, which includes the sibling-owned testkit temp propagation/startup-error fix. Final checks ran on **`82b660a6fbf0fac1fc3df4a4cad841a895b5e63e`**; the subsequent commit only records these logs/documentation. This branch adds no testkit/product changes.

| Check | Exit / result |
|---|---|
| `npm run build` | **0** |
| `npm run typecheck` | **0** |
| Direct `./node_modules/.bin/oxlint` | **0**, empty diagnostics |
| `TMPDIR=/home/mark/f151 ./node_modules/.bin/vitest run` | **0**, **102 files / 845 tests passed** |
| `env -u FOUNDRY_PI_BIN TMPDIR=/home/mark/f151 npm run test:e2e` | **0**, **3 files / 5 tests passed**; normal pinned launcher, **no shim** |

All final logs and explicit commands/exits are under `checks/`. The short disk-backed parent TMPDIR is now propagated by the merged shared testkit into its isolated children, so the normal interrupt e2e passes without `FOUNDRY_PI_BIN` or a launcher replacement. The old failure and shim pass remain historical, not overwritten as a normal pass.

The **original probe product base remains `050145655c76a722afc6bce70ae422397e49872c`**; it has not been relabeled as running on the later integration base. The later checks establish regression integration, not a new resource-gate observation set. The scoped Linux SDK isolation/named-tool result is supported and independently re-reviewed. Other platforms/gates remain unqualified; actual faux tool round trips are not a skill-body read, and zero intercepted fetches are not OS network isolation. PR creation against `develop` is authorized; no merge, watch or Linear update is part of this handoff.
