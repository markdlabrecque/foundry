# FOU-135 — real subscription ticket: blocked at specification

## Verdict

**Not supported. The one actual run failed to progress beyond specification.** The configured Claude subscription returned a real assistant response, but its apparent tool invocations and tool results were **plain text**, not executed Pi tool calls. Foundry remained at `specify / assigned`; there was no implementation, independent review, verification, approval, integration, or landed change. The real-ticket acceptance criterion remains unmet. This is not an unavailable-login finding and is not a P0 release qualification.

Source: [FOU-135](https://linear.app/foundry-mdl/issue/FOU-135/run-one-real-ticket-with-a-real-model), PRD §18.1(1,3,5). The live issue, authorization, empty comments and relations were read. Its prerequisites [repository context](https://linear.app/foundry-mdl/issue/FOU-23/send-repository-context-alongside-each-assignment), [merge verification](https://linear.app/foundry-mdl/issue/FOU-48/verify-the-proposed-merge-before-changing-default), and [Linux launcher qualification](https://linear.app/foundry-mdl/issue/FOU-145/qualify-the-selected-launcher-for-p0-release) are present at the tested product base. The [scripted line](https://linear.app/foundry-mdl/issue/FOU-119/prove-the-scripted-ticket-line-wiring) and its actual current E2E fixture were inspected as contracts, not substituted for a model. The [earlier real-model context report](real-model-repository-context.md) is a historical model-policy block, not positive behavioral evidence. The explicit current authorization resolves that policy boundary only for this one disposable journey.

## Exact scope and provenance

- Freshly fetched `origin/develop`, exact tested product/base **`fa1f40ee85daea577ad617ffaf0e3ce625dcb825`**; branch `marklabrecque/fou-135-real-ticket`. No product, dependency, operator configuration, automated test, or default-runtime change.
- Linux `7.2.15-1-omarchy`, Node `v22.23.2`, npm `10.9.8`, pinned worker Pi **1.6.0**, Claude Code **2.1.332**. See [provenance](p0-real-ticket/provenance.json) for source/build/lockfile and provider-source SHA-256 hashes. Outer harness version is not worker version.
- Explicit **`FOUNDRY_WORKER_RUNTIME=sdk`**, `FOUNDRY_PI_BIN` absent. Fresh disposable protocol-v5 daemon/host. RPC remains the product default. No shim or real operator host involved.
- Only the approved hooks-only extension `<provider>/index.ts`, resolved to `/home/mark/.pi/agent/extensions/pi-claude-subscription/index.ts`, plus the mandatory Foundry extension. No observer extension, scripted provider, context rewriting, hand-authored stage outputs, or direct store mutation.
- Configured model **`pi-claude-subscription/claude-sonnet-5-5`**, the available latest Sonnet family selector in the pinned catalog and extension's filtering logic. The session records that provider/model. This is the configured/reported alias, **not an independently captured upstream deployment identifier**.
- `claude auth status` exited 0; output discarded. No credential/auth JSON or secret environment values were read, copied, logged, requested or resolved. No 1Password, login setup or API-key fallback. An allowlisted child environment retains ordinary HOME/XDG read access for the existing Claude login; private Pi agent/state/TMPDIR and Git config isolation keep the product fixture separate. No assertion that ordinary CLI login consumption performs zero internal operator-home writes.
- Provider source inspected: Claude built-in tools disabled (`--tools ''`), settings sources empty, slash commands disabled, strict generated MCP schema-only server, isolated transport cwd/system prompt, custom tool execution denied inside Claude and delegated to Pi. No automatic dangerous permission mode enabled. Replay mode disables Claude session persistence. Explicit API-key fallback disabled. The Foundry fixed tools are **not an OS sandbox**; role instructions restrict all work to the disposable root and prohibit secrets, network, other agents, global config and Git pushes.

## One bounded actual attempt

[Executed manual driver](p0-real-ticket/run.mjs), [factory YAML](p0-real-ticket/run/factory.yaml), [actual request](p0-real-ticket/run/request.md), [role instructions](p0-real-ticket/run/roles/), [ordered operator command journal](p0-real-ticket/run/commands.json), and [result](p0-real-ticket/run/result.json).

The requested change was a pure `clamp(value,min,max)` function for finite numbers with ordered bounds, cheap `node:test` coverage, and no dependencies. Four distinct stations/conversations were configured: specification, implementation, independent review, verification. Public specification/repository/evidence files were the artifact contract; worker-to-worker handoffs were required to use `agent_message` only. A real CLI approval was authorized but **never reached**.

The actual daemon argv is retained in `result.json`; every operator CLI/Git invocation and its argv order, cwd, exit and output is in `commands.json`. Per-worker/Claude subprocess argv was **not sampled from the live OS**; the source hashes and configured YAML identify the launcher inputs but do not replace that missing capture. No raw upstream HTTP traffic/headers or audit-to-operator-extension files were captured.

| UTC, 2026-11-26 | Observed event |
|---|---|
| 03:47:27.411 | Run begins after existing-login availability check. Disposable source baseline `80d08e7292ae1fa8e19cbcec1b949b40e9edc2de`. |
| 03:47:28.100 | Fresh host `5514c1ca-35af-4892-bc8c-610126077a07`, PID 3431121, boot `e4653541-62f1-4746-93c3-19c8d32b3110`. Four SDK workers start. |
| 03:47:28.996–03:47:29.020 | All four channels accepted with the expected 12 tools. Four separate conversation refs retained in `store.json`. |
| 03:47:29.064–.078 | Assignment `4c46d82e-879d-4788-9b1b-9c8ac845257a` delivered to `specify/1`, conversation `06be0f78-65b9-4f53-8142-37c4283cb6cc`. Prime and specification path precede the model response. |
| 03:47:41.020 | One actual assistant response, `stopReason: stop`, duration 11,939 ms. Content contains `<invoke>` and `<turn role="tool_result">` **inside a text block**. No `toolCall` block or actual tool result. |
| 03:47:41–04:02:28 | Ticket remains assigned to specification. No stage outcome, evidence artifact, worktree, agent message, approval or operation appears. No further model turn is launched. |
| 04:02:28.546 | Driver reaches the single 900-second bounded journey deadline, records blocked, invokes actual CLI shutdown. |
| 04:02:28.816–.834 | All four launches end as requested, code 0; host stops. Daemon exits 0. |

The driver enforced an overall 50-assistant-response / 900-second bound and watched explicit model errors, paused state and blocked/rejected transitions. Its instructions requested at most ten responses per stage, but that per-stage limit was not separately enforced. Actual use was one visible response. **Limitation:** it did not recognize an idle text-only non-outcome as failure immediately; it waited until the deadline rather than stopping at 03:47:41. No retry, alternate model, second ticket or remediation run followed. The manual driver's process exited 0 after printing/preserving `verdict: blocked`; its exit status is not an acceptance oracle. The failure is inspectably preserved; **repeatability across another paid invocation is untested** and not claimed.

## Actual response versus actual effects

The complete [persisted specification-worker session](p0-real-ticket/run/state/slots/realticket/specify-1/sessions/2026-11-26T03-47-28-987Z_06be0f78-65b9-4f53-8142-37c4283cb6cc.jsonl) records a single assistant `content` block with `type: text`. It imitates reads, shell writes and `task_transition`. Its purported file read is not the actual submitted request, and it adds input validation explicitly excluded by that request. These are **model-generated unexecuted claims**, not evidence of filesystem actions or successful tools. No tool parser was added to interpret them.

Independent persisted-state observations in [read-only store export](p0-real-ticket/run/store.json):

- Four launches and four distinct current conversation refs; one assignment, at `specify`.
- One acknowledged ordinary **daemon assignment** message; **zero agent submissions**, zero agent-origin messages, zero delegations and requests.
- Four primes; zero approvals and zero integration/worktree operations.
- Two ticket transitions only: operator submission to backlog, daemon assignment to specification.
- Submitted spec remains unchanged; no stage evidence directory/report was created. No ticket worktree exists.

[Cleanup/end-state capture](p0-real-ticket/run/cleanup.json) independently checks source and clone clean, both still at **`80d08e7292ae1fa8e19cbcec1b949b40e9edc2de`**. **Landed commit: none. Landed diff: empty.** The fixture source is preserved under `run/fixture/`. Do not mistake the baseline hash for an implemented/approved commit.

### Consumption and attribution limits

One visible assistant/model response, zero executable tool calls, zero model retries, three other workers never assigned. Session-reported usage: input **2**, output **1,108**, cache read **0**, cache write **2,677** (also reported as one-hour cache write), total **3,787**. Do not double-count cacheWrite1h. These are provider-reported counters, not independently measured billing. Session cost fields are catalog estimates (`totalFromProvider: false`), **not actual Claude subscription charges**. No dollar billing claim. Exact upstream HTTP request count and hidden provider-internal retries were not instrumented; one persisted response is not proof of an exact upstream request count.

Acceptance is **blocked**. The visible symptom is a model/provider tool-interoperability failure: text emulates tools instead of exercising them. Whether the cause is model semantics, schema forwarding across the extension/pinned-Pi versions, or upstream transport behavior is **inconclusive**. The trace proves neither that Claude is generally incapable nor that Foundry's state machine/SDK launcher failed. Ordinary scripted line success cannot resolve that attribution. No authentication error, fixture test failure or product verification failure was observed because those stages never ran.

## Acceptance reconciliation and recovery

| Requirement | Status / evidence |
|---|---|
| Real configured subscription, no faux substitution | Observed existing login available and one real provider-reported response. Upstream deployment identity not separately captured. |
| Independent specification, implementation, review, verification outputs | **Unmet**: no completed specification output; later stations launched but never assigned. |
| Actual verification and exact evaluated/landed commit | **Unverified/unmet**: never reached; source and clone unchanged. No real-ticket tests ran. |
| Channel-only inter-agent communication | No bypass observed; actual assignment used Foundry channel. **Positive inter-agent handoff unverified**, because no agent communication occurred. Model text is not a channel call. |
| Operator CLI observation/intervention/approval/integration | Observation, submission and shutdown exercised. **Approval/integration unmet**, not called. No fabricated approval. |
| Clean disposable end state | Verified: all four owned PGIDs and daemon/host PIDs absent before fallback; no fallback used; clean source/clone, no ticket worktree; only owned root removed. |

**Disposition: retain this work on FOU-135, keep its positive acceptance and downstream [FOU-140 release evidence](https://linear.app/foundry-mdl/issue/FOU-140/record-the-completed-p0-bar-and-release-evidence) held.** No new ticket, closure, PR or merge is performed. Next owner action is a scoped diagnosis of real subscription tool-schema delivery and native tool-call interpretation using this trace, followed by an explicitly bounded authorized retry of FOU-135 once a cause/candidate remedy exists. Do not switch to scripted output or count this evidence merge as the missing outcome. Root-cause diagnosis/remediation is not attempted under the one-run stopping rule. The old FOU-46 context behavior remains separately unverified; no macOS, crash durability or full-P0 claim.

## Archival details and verification

All product and provider source/build hashes are in `provenance.json`; the executed driver's hash is recorded separately. Known fixture/repo/provider/node/private-TMPDIR path prefixes are normalized; IDs, timestamps, model content, argv ordering and counters remain. Trailing whitespace is trimmed. [Normalization manifest](p0-real-ticket/normalization.json) identifies final normalized file hashes. `collect.py` is a post-run archival helper, not an acceptance checker. Its first execution exported the disposable DB and verified/removed the owned root, then failed on an SQLite read-only-open sidecar during normalization. Sidecars were removed and normalization resumed without product/model execution. The helper was corrected to use immutable read-only SQLite for future capture; that correction was **not** used to re-run the journey. Original binary DB hash was not retained; the JSON table export, session and logs are the retained evidence. This archival error is separate from the already observed specification failure.

No new acceptance checker, automated test, test fixture or test configuration was added or changed. This is manual integration evidence; no cheaper tier can prove the actual Claude subscription→SDK→channel journey. The writing-tests and recovery skills were read before execution. A synthetic unit assertion over the assistant's text would not prove tool interoperability or successful acceptance.

Normal checks on this evidence candidate, with no shim, private home-backed TMPDIR explicitly inherited by children:

| Command | Result |
|---|---|
| `npm ci` | exit 0; zero audit vulnerabilities |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| Direct `./node_modules/.bin/oxlint` | exit 0 |
| Full `npm test` | **105 files / 862 tests passed** |
| Separate `npm run test:e2e` | **3 files / 5 tests passed**, including ordinary scripted ticket-line journey |
| `git diff --check` | exit 0 |

[Check logs/statuses](p0-real-ticket/checks/). These green checks qualify only ordinary repository health, **not** the failed real-ticket journey. Evidence/source/build hash verification is performed before pushing the candidate. Fresh independent GPT 6.1 SOL review is still required; no PR/watch/merge/Linear closure/coordinator CURRENT edit here. The issue-link tool was attempted and returned “Issues cannot be browsed for this project yet.”
