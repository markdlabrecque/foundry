# FOU-151: SDK resource isolation and named tools — Linux

Draft 56h; PRD §17.2 resource-isolation observations and §17.3 actual named-tool call. This is the SDK sibling of [RPC Linux evidence](rpc-53-2-linux.md), using the adapter described in [SDK trial](sdk-147-trial.md). No product changes, collision/missing-registration work, reconnect work, macOS qualification, or other gate work is included.

## Verdict: blocked on the tested approach; NOT a gate pass

The actual Worker Host explicitly selected the pinned SDK entry with `FOUNDRY_WORKER_RUNTIME=sdk`. Two configured workers authenticated, used the intended faux model and skill/extension, excluded calibrated ambient resources, and each called only the YAML-named registered fixture tool. The skill-clear override was effective.

The fully cleared station **never connected**: its independent disposable `models.json` model was not registered by the SDK adapter. Three automatic host launches reproduced `SDK model is not registered: probe-local/inert`, then the harness's three-accepted-channel deadline expired. Stop here: the passing criterion remains **unmet**. The SDK platform's ability to support an independently registered credential-free clear-station model is **inconclusive**, not disproved. Do not close a passing qualification criterion from this negative evidence.

This is a tested adapter/fixture compatibility limitation, not an infrastructure timeout or proof that cleared lists themselves leak. The adapter deliberately constructs `ModelRuntime` with `modelsPath: null`; the sibling RPC harness relies on a disposable `models.json` provider to let `extensions: []` start without its faux-provider extension. No product fix or credential workaround was applied to force a pass.

## Per-observation status

[`observations.json`](sdk-53-2-linux/observations.json) contains independently recomputed assertions against retained raw output. Reproduce its analysis with the retained `summarize.mjs`; it does not start workers or directly invoke tools.

| Observation | Status and evidence |
|---|---|
| Actual SDK host and Foundry channel | **Verified:** captured argv enters `packages/host/dist/sdk-worker.js`; accepted `inherit/1` and `skillclear/1`, each with 13 tools and host launch identity. Neutral slot cwd is outside the source repo. |
| Ordinary-launch global control | **Verified:** ordinary pinned Pi loads `GLOBAL_EXTENSION_53A`, starts the fixture MCP server, activates `grep` from global `defaultTools`, and passes global AGENTS/SYSTEM/APPEND markers and `mcp__probe__ambient` to the faux model. |
| Intended model and configured extension | **Verified:** both worker `session_start` observations identify `probe-faux/scripted`, not the conflicting global `wrong-control/wrong-control`; configured extension startup is recorded. |
| Configured skill and skill-clear override | **Verified:** `CONFIGURED_SKILL_53A` description/path appears in inherited worker model input and not `skillclear/1` input. This proves skill indexing, not a model reading its body on demand. |
| Global extension, MCP, defaults and context excluded | **Verified for the two connected workers:** no ambient extension/MCP worker startup; no global context/system markers in actual model requests; explicit tool declarations contain 12 fixed tools plus `probe_named`, not `grep`, `find` or MCP tools. |
| Repository resources excluded | **Verified on neutral-cwd approach:** disposable source contains marked root AGENTS and `.pi` extension, skill, settings and system prompt; none reaches worker input/startup. No trusted ordinary repository baseline was run; do not generalize to every trust mode. |
| Named registered tool and unnamed registration | **Verified:** shared fixture registers `probe_named` and `probe_unnamed`; ordinary registry shows both. Each configured worker executes exactly one `probe_named({value:"CALL_MARKER_53A"})`; its second faux-model request contains `TOOL_RESULT_53A:CALL_MARKER_53A`. `probe_unnamed` is absent from worker model declarations. No direct driver call to the implementation. “Only named” applies to configured extension tools, not removal of fixed tools. |
| Fully cleared inheritance | **Partial/unmet:** all three clear-worker argv records omit configured extension and `--skill`; no configured startup marker. But none reaches hello, so absence of its tools in a live cleared worker remains **unverified**. |
| Full passing criterion | **Unmet:** partial positives plus a reproducible clear-station startup failure are not passing gate evidence. |

The 12 fixed tools now exist in this base; the historical RPC record's 5/6-tool counts are not the SDK expected counts. Missing YAML registrations, reserved-name collisions and broader §17.3 real-model repository/skill-read behavior are outside this draft's agreed observations. No real provider request was made.

## Reproduction, versions and exact launcher

Manual real-process integration evidence, **not** a timing-dependent commit-tier test. A cheaper in-memory test cannot demonstrate actual ambient discovery, the detached host boundary or a model tool round trip. Reuse the sibling's fixtures and recording preload rather than copy product logic.

```sh
npm ci
npm run build
# Use a fresh private home-backed temp dir if /tmp is inode-exhausted.
mkdir -p /home/mark/fou151-private-tmp
TMPDIR=/home/mark/fou151-private-tmp \
  node docs/evidence/sdk-53-2-linux/run-probe.mjs /home/mark/fou151-output
# Probe exits 1 at the reproduced clear-station failure, then analysis is separate:
node docs/evidence/sdk-53-2-linux/summarize.mjs /home/mark/fou151-output
```

The retained run was `node docs/evidence/sdk-53-2-linux/run-probe.mjs /tmp/fou151-evidence-final`, at `2026-11-26T00:47:50Z`, before the later regression-suite inode errors. Its disposable root `/tmp/fou151-qFno4S` was removed after shutdown. `FOUNDRY_PI_BIN` was unset; SDK selection is explicit in the allowlisted daemon/host/worker environment. The ordinary calibration intentionally uses normal Pi RPC launch, not SDK, so discovery remains enabled.

- Foundry source base: `050145655c76a722afc6bce70ae422397e49872c` (`origin/develop`, includes merged SDK adapter).
- Pinned worker Pi **1.6.0**, Node **v22.23.2**, npm **10.9.8**. Outer harness model: `openai/gpt-6.1-sol`; not used by the fixture.
- Linux: `Linux omarchy 7.2.15-1-omarchy #1 SMP PREEMPT_DYNAMIC Mon, 02 Nov 2026 10:32:17 +0000 x86_64 GNU/Linux`.

For readability `$W` below is the captured checkout `/home/mark/worktress/develop/t3-2b8eba8e-cff669249e50faa9`; the artifact preserves absolute argv and cwd without abbreviations. The host supplies RPC-compatible flags for SDK parsing; the entry is SDK, not the RPC server.

```sh
/home/mark/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node \
 "$W/packages/host/dist/sdk-worker.js" \
 --mode rpc --system-prompt '' --append-system-prompt '' \
 --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
 --no-context-files --no-approve \
 --session-id 2dc609cb-b431-4914-928d-4da6eb32652d \
 --model probe-faux/scripted \
 --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_named \
 --extension "$W/packages/extension/dist/index.js" \
 --extension "$W/docs/evidence/rpc-53-2-linux/fixture.mjs" \
 --skill /tmp/fou151-qFno4S/skill/SKILL.md
# cwd: /tmp/fou151-qFno4S/state/slots/probe/inherit-1
```

Ordinary calibration command: the same Node executable, `$W/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc --model probe-faux/scripted --extension "$W/docs/evidence/rpc-53-2-linux/fixture.mjs"`, cwd the disposable user home. Its complete stdout and model context are retained.

### Effective fixture

Full YAML, resolved validation and disposable environment are in `result.json`. Defaults: `probe-faux/scripted`, one configured skill file, configured fixture extension object with `tools: [probe_named]`. `inherit` inherits both lists; `skillclear` sets `skills: []`; `clear` sets both lists empty and model `probe-local/inert`. That independent provider is defined in disposable `models.json` with dummy `apiKey: none` and closed loopback `http://127.0.0.1:9/v1`; it is never called. Every station is worktree-isolated; source is a freshly initialized disposable repository with hooks disabled for its fixture commit.

All user HOME, agent, XDG, source, session and state directories are disposable. No real `~/.pi`, operator config, production, 1Password, credential or paid real model call is used. `NODE_OPTIONS` only imports the sibling recording preload, which records argv/output and does not replace the host executable. Global MCP is a local fixture process, not a real service.

## Failures, limits and independent remediation

An initial fixture-development run selected idle builtin `openai/gpt-4o` for the fully cleared station; it exited before hello because the isolated home had no provider credentials (`setModel` requires auth). No prompt was sent to that station and no real provider request occurred. This was an observation-fixture error, not a negative SDK isolation result. Its sanitized output is retained as `fixture-error.json`; startup stderr was not collected by that earlier driver revision, so the auth diagnosis is source-supported, not a retained error trace. It is not counted as qualification evidence.

The corrected retained run restores the sibling's credential-free independent loopback model. `result.launchErrors` captures the **three identical explicit unregistered-model errors**, and `hostLog` ties them to the clear station's launch IDs and exit code 1. The failure is registration, not the later `/tmp` inode exhaustion. Both configured faux workers completed their tool round trips during this run. The daemon performed its normal automatic retries; the probe starts no further approach after retaining the reproducible failure.

Independent follow-up, not implemented here: agree how the SDK should register an explicitly selected disposable model independently of removable extension lists (or approve a different credential-free clear-station fixture). Loading arbitrary global resources or retaining an inherited extension merely to keep its provider would weaken the gate. Decide that seam separately, then rerun the whole observation set with a live fully cleared station. This record does not prescribe loading all global model configuration or changing the product to satisfy a fixture.

## Cleanup evidence

The driver sends `foundry shutdown --force --home <owned disposable state>` only. It never signals by executable-name match. Raw shutdown: `factory probe stopped (2 worker(s))`, `worker host stopped`, `shutdown complete (forced)`. Host logs show the two accepted worker launches ended as requested; the failed clear launches had already exited.

`ownedBeforeShutdown` records only `/proc` processes whose environment includes this run's unique `PROBE_MARKER_DIR`: host PID/PGID **2410261**, workers PID/PGID **2410280** and **2410281**, and the foreground daemon. `ownedAfterShutdown` is empty. A subsequent exact-PGID `ps -eo pid=,pgid=,stat=,args=` inspection found **no members** of these three detached owned groups; retained in `cleanup.json`. This checks group members even if they removed the marker. No unrelated cleanup was performed. This is cleanup proof for this probe, not the separate explicit-stop cross-factory gate.

## Retained artifacts and repository checks

- [`sdk-53-2-linux/run-probe.mjs`](sdk-53-2-linux/run-probe.mjs): SDK selector wrapper around existing sibling harness. Shared harness changes are limited to runtime selection, current SDK expected count, and owned-process/error evidence retention.
- [`result.json`](sdk-53-2-linux/result.json): raw corrected run, versions, exact commands, effective YAML/validation, marker JSONL, actual model contexts/tool results, worker argv, daemon/host logs, clear-launch stderr and shutdown snapshots.
- [`summarize.mjs`](sdk-53-2-linux/summarize.mjs), [`observations.json`](sdk-53-2-linux/observations.json), [`cleanup.json`](sdk-53-2-linux/cleanup.json), [`fixture-error.json`](sdk-53-2-linux/fixture-error.json).
- [`checks/`](sdk-53-2-linux/checks/): retained successful regression logs and infrastructure-only Pi wrapper.

Repository checks are separate from the **blocked** probe outcome:

- Build: exit **0**; typecheck: exit **0**; direct `./node_modules/.bin/oxlint`: exit **0**, empty diagnostics.
- Full direct Vitest with private home-backed `TMPDIR`: **100 files / 837 tests passed**, exit **0**.
- Separate e2e with private parent and child temp directory: **3 files / 5 tests passed**, exit **0**. Exact command: `TMPDIR=/home/mark/fou151-check-tmp FOUNDRY_PI_BIN=/home/mark/fou151-check-logs/pi-with-private-tmp ./node_modules/.bin/vitest run --config vitest.e2e.config.ts`. The retained wrapper exports only `TMPDIR` then execs the pinned Pi unchanged with all arguments. This environment workaround is regression-check wiring, **not used for the SDK probe**.
- Initial default-`/tmp` full suite: **29 failed / 71 passed files; 193 failed / 587 passed / 57 skipped tests**. Separate e2e: **4 failed / 1 passed**. Infrastructure failures included `ENOSPC` mkdtemp and SQLite unable-to-open DB errors. `df -i /tmp` showed **1,048,576 / 1,048,576 inodes used**, despite 22 GiB free space. Moving parent TMPDIR alone passed full Vitest but left interrupt e2e timing out (**4/5 passed**), because its testkit intentionally omits parent TMPDIR from the worker environment; giving the unchanged pinned child a private TMPDIR passed all five. No product/test changes or unrelated temporary-directory cleanup were made.

Fresh independent review remains required. No PR, merge or Linear update is part of this task. Regression health does not change the unmet passing qualification criterion.
