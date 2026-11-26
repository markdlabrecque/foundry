# FOU-145 — Linux SDK launcher qualification traceability

## Decision, scope and selection

**Qualified for the original Linux launch-gate scenarios below, with explicit SDK selection, at product commit `a61daf0913331e83cb111c6b6572a8a3bba2f434`. Fresh independent review of this qualification record is still required. P0 release remains held.** This is a bounded evidence decision, not a product-default change or an assertion about every possible worker workload.

[FOU-145](https://linear.app/foundry-mdl/issue/FOU-145/qualify-the-selected-launcher-for-p0-release)'s live body, comments (none), relations, [FOU-136](https://linear.app/foundry-mdl/issue/FOU-136/record-the-rpc-gate-decision), SDK adapter selection and all five Linux SDK prerequisites were read on 2026-11-26. Their original reports and actual retained artifacts, not `Done` statuses or green CI, support the decision. The live ticket explicitly records the user's **macOS waiver for FOU-145**. Its historical both-platform wording is superseded only in that respect. macOS is **waived/unverified, not passed**; canceled or Mac-labeled sibling issues are not positive evidence.

**The product still defaults to RPC.** The route qualified here requires this invocation on a newly started daemon with its matching fresh host:

```sh
env -u FOUNDRY_PI_BIN FOUNDRY_WORKER_RUNTIME=sdk \
  node packages/daemon/dist/main.js --home <disposable-state> <factory.yaml>
```

The host executes `packages/host/dist/sdk-worker.js`, creating the pinned Pi SDK session. The inherited `--mode rpc` argv is compatibility/resource-selection syntax, **not** evidence that this is an RPC worker. Unset or `rpc` keeps the RPC default; unknown selectors fail; SDK rejects a `FOUNDRY_PI_BIN` override. See [adapter trial](sdk-147-trial.md) and `packages/host/src/launch-command.ts`. No default, provider configuration, launcher, product, shared testkit or automated test changed here.

### Why SDK is still the qualification route

The [FOU-136 decision](rpc-gate-decision.md) correctly authorized an SDK trial on one reproduced RPC failure. Both SDK and RPC historically lacked the shared Foundry extension redial. That was a failure of the tested implementation, **not intrinsic RPC incapability**. The historical decision/report is preserved, not silently rewritten.

Reconnect is now positively observed for **both** runtimes after `477b169f2b23a1a952008b2f5d7a5b28d02324bb`: [SDK post-merge report](sdk-52-1-linux-postmerge.md), [RPC post-merge report](rpc-52-1-linux-postmerge.md), each 11/11. RPC's acceptance merged as `94ac81d`; SDK's as `a61daf0`. There is **no remaining demonstrated current RPC reconnect failure**. No other current RPC failure is asserted by this review. Conversely, the historical RPC resource/collision reports are not current blanket qualification: the resource driver itself labels its old five-tool expectation historical, and agent-tool registration/loader behavior has evolved. This task does not recertify those RPC cases or switch selection automatically. It completes the explicitly requested Linux SDK evidence route. **Running the default RPC invocation does not invoke this SDK qualification.**

## Evidence index and immutable provenance

All original links below resolve to files retained unchanged in this repository. For an immutable snapshot, use [the complete evidence tree at the reviewed product base](https://github.com/markdlabrecque/foundry/tree/a61daf0913331e83cb111c6b6572a8a3bba2f434/docs/evidence). The [provenance manifest](linux-launcher-qualification/provenance.json) records full product bases, SHA-256 bytes of the original reports/artifacts, relevant old/current product source comparisons, current source/build hashes, and new recheck artifacts. An observation checkout can contain uncommitted **evidence**; that is distinguished from its product base rather than falsely calling the whole tree clean.

Common runtime: **Linux x64, kernel `7.2.15-1-omarchy`, Node `v22.23.2`, npm `10.9.8`, lockfile-pinned Pi `1.6.0`**. The outer agent harness's Pi version is not the worker dependency. Lockfile SHA-256: `35b39e78be6478d4919b56f6ba6df3f7fba8bf0add4af04a32fbf428438ebccc`.

| ID / owner | Original actual evidence and product basis | Qualification use |
|---|---|---|
| S / [FOU-149](https://linear.app/foundry-mdl/issue/FOU-149/check-sdk-survival-and-reconnect-on-linux) | [Post-merge report](sdk-52-1-linux-postmerge.md), [summary](sdk-52-1-linux-postmerge/artifacts/summary.json), [provenance/argv/hashes](sdk-52-1-linux-postmerge/artifacts/provenance.json), [cleanup](sdk-52-1-linux-postmerge/artifacts/group-cleanup.json). Actual product `089ab52ac2deeeac53c59e8597605bcad309127a`. | 11/11 original checks. No product or lockfile changes between that run and this base. |
| R / [FOU-151](https://linear.app/foundry-mdl/issue/FOU-151/check-sdk-resource-isolation-and-named-tools-on-linux) | [Report](sdk-53-2-linux.md), [actual capture](sdk-53-2-linux/result.json), [prerequisite-aware observations](sdk-53-2-linux/observations.json). Product `050145655c76a722afc6bce70ae422397e49872c`; capture checkout `5e67e08b500a287e3b6854883d22bc34f3dfaa6d`, with evidence recovery edits. | Original 8/8 observation groups supported; current-base targeted rerun R′ also 8/8. |
| T / [FOU-153](https://linear.app/foundry-mdl/issue/FOU-153/check-sdk-tool-set-mismatch-and-collision-on-linux) | [Post-merge acceptance report](sdk-53-3-linux-acceptance.md), [assessment](sdk-53-3-linux-acceptance/results/assessment.json), [source provenance](sdk-53-3-linux-acceptance/results/source-provenance.json), actual [missing](sdk-53-3-linux-acceptance/results/missing.json), [reserved](sdk-53-3-linux-acceptance/results/reserved.json), [agent-name](sdk-53-3-linux-acceptance/results/agent-name.json), [cleared](sdk-53-3-linux-acceptance/results/cleared.json) records. Product `1bde222862fbf6d1d4ba311faa85cf62ee601c46`. | All original named/source holds and clearing observations, plus unchanged/corrected unfreeze controls. Applicability below; no invented hello for the pre-session agent collision. |
| X / [FOU-155](https://linear.app/foundry-mdl/issue/FOU-155/check-sdk-explicit-stop-on-linux) | [Report](sdk-54-4-linux.md), [raw summary](sdk-54-4-linux/summary.json), [SDK assessment](sdk-54-4-linux/sdk-assessment.json). Product `050145655c76a722afc6bce70ae422397e49872c`; follow-up evidence 2026-11-26 01:02:23–01:02:46 UTC. | 8/8 SDK contract checks; raw RPC-oriented result remains **failed, 11/13**. Current-base targeted rerun X′ confirms the same distinction. |
| P / [FOU-148](https://linear.app/foundry-mdl/issue/FOU-148/prove-sdk-restoration-and-the-three-prime-situations) | [Report](sdk-restore-and-prime.md), [fixed-driver actual capture](sdk-restore-and-prime/result.json). Product `6dc2a5b5f01b9be13d465bccecedc67f04e8410c`; fixed evidence checkout `0fe083b318cc4acd9bf1a4a929bb47d9f8d64ab8`. | Same persisted conversation, no completed-effect replay, channel and all three prime situations. Current-base targeted rerun P′ confirms after reconnect changes. |

## Every original required Linux scenario

Contract: [PRD §17.2](../../prd.md#172-launch-gates-not-yet-passed); the SDK additions are mandatory, not optional. Every row below is **verified within its stated fixture scope**. There is no unmet original Linux row; the explicit exclusions later in this report are not passes.

| Requirement | Positive observations / actual artifact location |
|---|---|
| §17.2(1): two busy workers, distinct slots, recorded host and launches | S `summary.log`: both `probe_hold` witnesses, accepted channels/receipts/heartbeats. Host `890bfd1b-7296-4a5c-9b05-4909253af284`; original launches `39d1a541-0532-48a3-ae76-5e4a023564ac` / `16b39346-058c-4a6f-b2fd-e99e506e7cd8`, PID=PGID 3141427 / 3141433. |
| Daemon-only abrupt kill; original workers/host survive | S observes daemon 3141396 SIGKILL, unchanged host 3141410 and both original live PIDs. Old daemon sockets disappear (negative control). |
| Original identities reconnect, traffic resumes, same slots/no replacements | S restart daemon 3141934; accepted original hellos at `02:40:17.916Z` / `.918Z`, two heartbeats each, peer sockets point to restarted daemon. Same `hold/1`, `hold/2`, inventory exactly original two launches, unchanged busy records. Required traffic here is authenticated heartbeats, **not a new application delivery or committed tool effect**. |
| §17.2(2): explicit model, configured skill/extension effective; Foundry channel connects | R/R′ actual SDK startup identifies `probe-faux/scripted`; inherited model request indexes `CONFIGURED_SKILL_53A`, configured-extension marker present, three actual hellos accepted, 13/13/12 tools. Full YAML, commands, cwd and model contexts in `result.json`. |
| Discoverable unconfigured operator-global extension, first calibrated ordinary launch | R/R′ ordinary pinned Pi actually loads `GLOBAL_EXTENSION_53A` and global context/system markers, starts the local MCP fixture and exposes `mcp__probe__ambient`; `defaultTools: [grep]` active. Absence in SDK workers is not an empty-global or missing-model-request inference. |
| Cleared inherited resource list | R/R′ `skillclear/1` has no skill marker/path in actual model context while `inherit/1` does; `clear/1` has no inherited skill/extension argv and 12 fixed tools. |
| Tool Set overrides global defaultTools/MCP | R/R′ configured model declarations exactly the 12 fixed tools plus `probe_named`; no `grep`, `find`, MCP or unnamed registration. Ordinary control above proves those ambient sources were discoverable. |
| Global context and repository `.pi` excluded | R/R′ workers run outside the marked source repo in neutral slot folders. Actual model inputs lack global AGENTS/SYSTEM/APPEND and repository AGENTS/extension/skill/settings/system markers. Repository exclusion is the **neutral-cwd approach**, not proof for arbitrary repository trust/cwd modes. |
| Named registered tool callable, unnamed registration absent | R/R′ faux model itself emits `probe_named({value: "CALL_MARKER_53A"})`; actual execution once per configured worker, subsequent model request contains `TOOL_RESULT_53A:CALL_MARKER_53A`; `probe_unnamed` absent from declarations. Driver does not call tool implementation. |
| Unregistered YAML tool freezes with named hold | T `missing.json`: frozen `tool_set_mismatch`, `missing` names `probe_absent`, source `…/fixtures/missing.ts`; one launch ends requested. |
| Configured extension colliding with `read` refused/source shown | T `reserved.json`: frozen named hold `replaced: read`, expected `builtin:read`, actual `…/fixtures/reserved.ts`; one requested end. |
| Agent-tool name collision refused/source shown | T `agent-name.json`: actual host startup diagnostic and frozen `tool_set_mismatch` name `agent_message`, expected Foundry `dist/index.js`, actual `…/fixtures/agent-name.ts`. Exactly one initial collision launch, not three-exit parked recovery. Unchanged explicit unfreeze refuses with same named/source hold; corrected disposable YAML + restart/unfreeze accepts a new launch and resolves hold. |
| `extensions: []` gets neither extension nor tools | T `cleared.json` plus R/R′: actual accepted clear hello 12 fixed tools, no named fixture in argv/markers; inherited positive control accepted 13 with `probe_named` attributed to `named.ts`. Cleared metadata-only builtin model is never prompted; intentionally fake disposable auth and fetch-denial witness are not real credentials or model use. |
| §17.2(3): active named-factory scoped stop, neighbor survives | X/X′: alpha's two workers and beta's one all inside actual faux `probe_hold` calls with live non-detached children. Non-force alpha stop returns exactly its two launch IDs, both escalated; both alpha groups disappear. Original beta leader/child and same inventory launch remain alive before shutdown. |
| Bounded escalation with child; whole-instance shutdown leaves no owned groups | X′ `stop/summary.json`: alpha stop 10,331 ms; beta shutdown 10,605 ms, both within unchanged 17,000 ms bound. All three worker/child groups absent, host gone, daemon exit 0, no marked processes **before fallback**. Raw flags requiring child-after-leader survival remain false; §17.2 requires bounded group termination with non-detached child, not that extra RPC signal-ordering behavior. X/X′ SDK assessment independently verifies all eight contract checks without rewriting raw failures. |
| SDK extra: working extension channel | P/P′ accepted fresh/replacement launches, actual operator-message delivery/receipts and model-emitted `agent_discover` receives a real committed handler result. Not a synthetic direct tool invocation. |
| SDK extra: same conversation after worker exit, without execution replay claim | P/P′ first completed `probe_once` effect and on-disk call/result/final answer persist. Kill only marked original worker group; replacement launch opens same session ID/file/history. Exactly one effect remains after recovery and compaction; idle replacement makes zero model requests before work. **No interrupted-tool/external exactly-once generalization.** |
| SDK extra: fresh prime | P/P′ one fresh prime; idle prime alone causes no model turn/file, remains unacknowledged until first work persists it. Actual first model history includes full prime. |
| SDK extra: recovery prime | P/P′ new launch/same acknowledged conversation, one acknowledged recovery prime; idle control no automatic work. Next model input includes recovery prime and prior result. |
| SDK extra: compaction prime | P/P′ real SDK manual idle `ctx.compact()` calls faux summarizer, emits real `session_compact`, one acknowledged compaction prime. PID/launch/conversation unchanged; prime alone starts no turn; next model context includes it. Independent oracle verifies complete header/conventions, ordered factory→room→station source bodies/hashes and disk/store equality for **all three** primes. |

## Code evolution and targeted applicability checks

Comparing the actual old product bases to `a61daf0` was necessary; passing old reports were not presumed to apply indefinitely. [Manifest source comparisons](linux-launcher-qualification/provenance.json) preserve exact old/current hashes and changed path lists.

1. **S: no applicable product evolution.** `git diff 089ab52ac2deeeac53c59e8597605bcad309127a..a61daf0913331e83cb111c6b6572a8a3bba2f434 -- packages package-lock.json` is empty. Only RPC/SDK acceptance documentation landed. S's positive actual-process observations apply directly; no duplicate reconnect probe was needed.
2. **T: collision issuer unchanged; channel lifecycle changed.** Host `sdk-session.ts`, `sdk-diagnostic.ts`, `sdk-worker.ts`, `launches.ts`, control protocol, daemon `slots.ts`, `tool-set-check.ts`, and channel `slot-claim.ts` match the tested `1bde222` product bytes. Agent-name collision happens before session/channel creation, so reconnect cannot bypass that check. Missing/reserved holds are produced by the unchanged daemon tool-set/slot boundary; the changed client still returns the actual `hello_rejected` reason. New `WorkerConnection` makes terminal refusals final (`terminal = true`, invalidate, no retry), and worker refusal persists at launch scope. It changes transport/reload lifecycle, not discrepancy naming, attribution or freeze. Accepted inherited/cleared hellos and current tool declarations are independently exercised by R′. No fresh T run is claimed; applicability of its named/source holds rests on this unchanged issuer mapping plus the explicitly inspected terminal-refusal path, not a claim that every source file stayed identical.
3. **R/P: required targeted rechecks.** SDK loader now adds pre-session agent-collision diagnosis; worker connection/session-start, receipt attach and compaction reporter lifecycle changed. Therefore historical resource/model and restored/prime observations alone were insufficient. Existing R/P manual drivers were rerun **unchanged** against `a61daf0`: actual SDK, calibrated ordinary Pi, credential-free faux providers, explicit private child TMPDIR. R′ verifies eight observation groups; P′ verifies all original restoration/channel/full-prime observations and orderly cleanup. Fresh launch `426b75b5-4487-4851-b47a-aa563cb7853a`, replacement `521e5221-0b29-4008-aa47-9f37721c542f`, same session `99cd8c6c-1ce8-4fac-b733-9d0e79b7ab1a`, one completed effect, three acknowledged primes and five acknowledged messages.
4. **X: required targeted recheck.** `terminate.ts` and launch resource argv selection are unchanged, but `launches.ts` now drains a startup diagnostic pipe before final exit reporting and changes group-empty tracking. Source inspection alone was not used to infer the stop-duration result. X′ reruns the same raw driver and same SDK assessment on current product code. Its only verification adaptation is [recheck-stop.mjs](linux-launcher-qualification/recheck-stop.mjs): two exact-single-match splices disable Git hooks for disposable fixture commits and redirect the SDK wrapper to that temporary driver. This avoids writing the operator's post-commit daily log. No process behavior, assertions, timings, assessment, fixture model/tool, or launcher is replaced. Temporary same-directory modules are removed in `finally`; hashes identify their parent sources and this adaptation. This is **not a Pi shim or product/testkit change**.

Rechecks are manual process-boundary/integration evidence, not new timing-dependent automated commit-suite tests. A cheaper unit test cannot prove actual Pi resource discovery, persisted SDK history/model context or OS process-group departure. The writing-tests skill was read first. No automated tests, fixtures or test configuration were edited.

## Reproduction and retained current-base artifacts

From repository root, on Linux with the pinned lockfile installed; choose a **short, private, home-backed** parent (socket paths must remain short):

```sh
umask 077
scratch=$(mktemp -d "$HOME/.f145-XXXX")
export TMPDIR="$scratch"
unset FOUNDRY_PI_BIN
npm ci
npm run build
node docs/evidence/sdk-restore-and-prime/run-probe.mjs "$scratch/restore"
node docs/evidence/sdk-53-2-linux/run-probe.mjs "$scratch/resources"
node docs/evidence/sdk-53-2-linux/summarize.mjs "$scratch/resources"
node docs/evidence/linux-launcher-qualification/recheck-stop.mjs "$scratch/stop"
npm run typecheck
./node_modules/.bin/oxlint
npm test
npm run test:e2e
git diff --check
# Inspect required observations/cleanup, retain evidence, then remove only owned scratch.
```

The SDK driver wrappers explicitly set the child selector. Each forwards private TMPDIR in its allowlisted child environment and owns disposable HOME/XDG/Pi agent/state/session/Git resources. No `FOUNDRY_PI_BIN`, diagnostic Pi shim, paid model, operator credentials, 1Password, production resource, provider config/global-default edit or unrelated temp/config/cache cleanup. R′'s deliberately fake `none` auth is fixture metadata only; the cleared worker is never prompted. Its deny-fetch witness records zero attempted fetches; this is not an OS-wide network sandbox claim.

Retained new files under [linux-launcher-qualification/](linux-launcher-qualification/):

- `rechecks/restore/result.json`: full normalized actual store/session/observer/cleanup capture; `restore.log` includes final verdict.
- `rechecks/resources/{result,observations}.json`: actual calibrated resource/model/tool capture and prerequisite-aware analyzer output (all eight verified).
- `rechecks/stop/{summary,sdk-assessment}.json`, YAML and daemon/host logs: raw **11/13 failed** retained alongside **8/8 supported** SDK contract assessment; no failure relabeling.
- `rechecks/cleanup.json`: independent subsequent exact-PGID inspection of all recorded current-recheck groups (including resource host), no members; resource/stop roots absent, restoration verified removal, temporary driver modules absent.
- `checks/`: ordinary command outputs, statuses/counts in `results.json`. Build/typecheck/direct lint success are separate from gate acceptance.
- `provenance.json`: product/source/build/evidence SHA-256 and exact revisions. Prefix normalization only: `<repo>`, `<node>`, `<resource-root>`, `<stop-root>`, `<scratch>`; P′ uses its existing `<fixture>`/`<private-tmp>` conventions. IDs, relative paths, argv ordering, observations, timings and raw error/verdict text retained. Trailing whitespace/blank lines trimmed; P′'s existing deterministic long padding abbreviation retained. Placeholders are not executable paths.

Final ordinary checks on the unchanged product base (with the new evidence driver present):

| Command | Result |
|---|---|
| `npm ci` | exit 0; zero audit vulnerabilities |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| Direct `./node_modules/.bin/oxlint` | exit 0; empty diagnostics |
| `npm test` | exit 0; **105 files / 862 tests passed** |
| Separate `npm run test:e2e` | exit 0; **3 files / 5 tests passed** |
| `git diff --check` | exit 0 |

All three current manual rechecks exit 0, with positive required observations and cleanup, not exit status alone as acceptance. Original failure records remain untouched: [SDK reconnect failure](sdk-52-1-linux.md), [SDK collision failure](sdk-53-3-linux.md), earlier resource fixture failures in `sdk-53-2-linux/history/`, original restoration verifier/observation errors and old shim-qualified regression runs. Current normal checks use **no shim**.

## Holds, exclusions and handoff

- **Not full P0 release:** [FOU-124](https://linear.app/foundry-mdl/issue/FOU-124/prove-worker-and-daemon-crash-durability-together) is still active for combined worker/daemon crash durability under §18.1(4). Passing busy-worker reconnect heartbeats and one completed-effect restoration do not establish no duplicate committed effects/lost tracked work in that combined journey. Its [blocked actual evidence](worker-daemon-crash-linux.md) remains historical; the reconnect fix is not acceptance of its original criterion.
- [FOU-135](https://linear.app/foundry-mdl/issue/FOU-135/run-one-real-ticket-with-a-real-model) still needs the real subscription-backed spec→implementation→independent review→verify→CLI approve→integrate ticket, independent outputs, landed commit and channel-only communication. Faux model calls here cannot satisfy it. No real-model execution or credential lookup was attempted.
- No macOS/full-cross-platform claim, automatic/busy compaction claim (§17.3), on-demand real-model skill-body read, interrupted execution replay, application-delivery-after-reconnect or arbitrary external exactly-once effect claim. Manual idle compaction proves the original SDK prime situation, not those distinct boundaries. Skill indexing and named faux tool execution do not establish model competence or the remaining §17.3 real-model check.
- **Host control protocol 4→5 requires operator-controlled shutdown and restart** with matching new daemon/host before use. Old running hosts are not compatible or silently upgraded. Only fresh disposable v5 hosts were used; no real operator host was contacted or changed. Channel wire version remains separately 1.
- This qualification is for the exact Linux SDK route and mapped source revisions above. Future changes to resource loading, tool validation, host lifetime, persistence, priming, channel authorization or dependency versions require renewed applicability analysis, not automatic inheritance of this verdict.
- Independent review must assess this new qualification decision and source mapping before a PR/acceptance transition. **No PR, watch, merge, Linear closure or coordinator CURRENT edit** is performed. Issue-link tool was attempted and returned “Issues cannot be browsed for this project yet.”
