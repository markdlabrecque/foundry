# FOU-124 post-merge positive combined-crash journey — Linux RPC

## Current correction — read first

Independent review returned **REQUESTCHANGES on the pre-review oracle**, while confirming the actual journey's relationships were correct. The revised oracle now enforces submission/tool-result/assignment/approval/Git bijections and all final acknowledged context/work relationships. **25 new negative corruptions fail against the old oracle; all 54 pure tests pass against the corrected oracle.** Both strengthened read-only replay of retained evidence and a fresh actual journey pass all 20 observations. Normal checks pass 862 Vitest tests and 5 separate E2E tests.

**The current canonical report is [review-fix/REPORT.md](worker-daemon-crash-postmerge/review-fix/REPORT.md). NEW independent review remains required before any PR.** Captured execution HEAD is `f380cd2c6c1161c04d30498c655000f0b8a16437`, with the exact revised source bytes runtime-hashed; fetched develop base remains `a61daf0913331e83cb111c6b6572a8a3bba2f434`. No product change or tracker action. Old artifacts/failures remain preserved, and pre-review source/report snapshots are archived under `review-fix/before-review/`.

## Pre-review report (retained historical run, not the current oracle qualification)

## Contract and disposition

[FOU-124](https://linear.app/foundry-mdl/issue/FOU-124/prove-worker-and-daemon-crash-durability-together), PRD §18.1(4): killing a worker and restarting the daemon mid-run loses no accepted messages or tracked work. The live issue's original checkbox remains open; its failure-evidence merge explicitly did not satisfy positive acceptance. It still owns the stronger successful-continuation/no-lost-work/no-duplicate-committed-effects proof and blocks [FOU-140](https://linear.app/foundry-mdl/issue/FOU-140). Live discussion comments were empty when read. Its listed dependencies FOU-162, FOU-70, FOU-95, FOU-94, FOU-64 and FOU-35 were all Done; FOU-162's shared implementation is now merged.

**Positive candidate acceptance evidence for this disposable Linux/RPC journey: exit 0, all 20 observations true. Fresh independent review is still required; no PR, tracker closure or release claim.** This time the workers do more than reconnect: both continue their interrupted tracked assignments through real agent-tool submissions to a unique operator approval gate, preserving accepted work and producing exactly one independently observable Git commit per ticket. There is no product code change in this branch.

The [historical blocked report](worker-daemon-crash-linux.md), its source and artifacts remain unchanged. This is a separate post-merge report, not a reinterpretation of its 45-second failures. RPC/SDK 52-1 gate acceptance is separately owned by FOU-83/149; those probes were not repeated here.

## Exact base, versions, launcher and reproducibility

- Initial fresh branch was created directly from fetched develop `089ab52ac2deeeac53c59e8597605bcad309127a`, containing shared reconnect `477b169` and FOU-153 acceptance `089ab52`. No merged feature-branch history was reused.
- **Final captured product base and validation base: `a61daf0913331e83cb111c6b6572a8a3bba2f434`.** Develop advanced with the separate FOU-83/149 evidence reports only; `089ab52..a61daf0` changes no product code. The stricter final oracle and actual journey were rerun after rebasing onto that latest base.
- Captured run: **2026-11-26 02:58:31–02:58:40 UTC**, Linux x64, kernel `7.2.15-1-omarchy`, Node **v22.23.2**, pinned Pi **1.6.0**. `run/result.json` includes exact runtime source SHA-256 for the runner, observer/provider, oracle, history helper and reused normalization/guarded-cleanup helpers. The acceptance additions were uncommitted during execution; product HEAD was the exact base above. `checks/source-hashes.json` also pins the unit-test sources.
- Default RPC route selected explicitly with `FOUNDRY_WORKER_RUNTIME=rpc`. **FOUNDRY_PI_BIN absent; no shim.** The real detached Worker Host uses control protocol **5**, under a fresh private state root, not an operator/old host. Full actual executable, ordered argv, neutral cwd, session file/conversation, PID, launch and effective TMPDIR are in `run/worker-events/worker.jsonl`.
- One factory `alpha`, station `eng.dev` with two instances, worktree isolation, writing `implement` stage followed by `gate` with operator approval. Both stages use the same real Pi station, not a driver-owned dispatch map. The effective YAML is in `run/factory.yaml`. Credential-free built-in pi-ai faux provider `crash-124/scripted`; one named fixture tool `fixture_work` plus unchanged fixed Foundry tools.

From the repo root, with dependencies installed and a fresh writable disk-backed output directory:

```sh
npm ci
npm run build
node --test docs/evidence/worker-daemon-crash-postmerge/verify.test.mjs
node docs/evidence/worker-daemon-crash-postmerge/run-probe.mjs "$OUT"
```

The runner creates its own short mode-0700 home-backed root (`<USER_HOME>/f124a-3kftxW` in the final run), private HOME/XDG/Pi/Foundry/Git/worktrees and child TMPDIR `.../t`. Only PATH is inherited; its unrelated value is not retained. Offline/telemetry guards, isolated Git identity/config and disabled fixture hooks are explicit. No production server, operator Foundry/Pi host/state, credential, 1Password, paid provider, global cache/config change or unrelated temp deletion. Releasing held tools uses owned fixture files, not stdin/terminal injection or a fabricated channel frame.

## What the fixture proves, without hiding repeated effects

`worker.mjs` registers an actual Pi faux model and tool. A **fresh** `fixture_work` invocation appends one assignment-specific line to `effect-<ticket>.txt` and makes a real local Git commit. This path is intentionally **non-idempotent**: a repeated fresh invocation appends again and creates another commit; there is no “already exists, suppress duplicate” guard. A completed commit is independently recorded outside the ticket/worktree in the append-only observer journal, then the tool remains active awaiting the owned release flag.

After worker death the real resume notice tells the scripted worker to inspect rather than blindly replay. The **resume** path verifies the existing assignment-specific file, records its SHA and holds without making a commit. This is the behavior of a worker obeying the product's recovery warning, not a guarantee against arbitrary/adversarial worker actions. The controller remembers already examined real Pi history so restored instructions are not mistaken for newly delivered instructions; that history includes Pi `custom_message` entries. Queued custom notices are observed at the real context boundary, even when they join a turn started by an ordinary message without another `before_agent_start`.

After daemon reconnect, the driver verifies that both existing tools are still held with no extra work call. It releases them. Each real Pi then calls the production `task_transition` tool over the authenticated channel. The daemon advances the ticket, schedules its real next-stage assignment, accepts that stage's outcome and creates an operator approval. The driver never invokes a Foundry tool handler directly, marks a ticket complete in SQL or manufactures acknowledgements.

The independent oracle checks real Git revision lists/diffs/body, external commit-attempt/commit/continuation records, before/after database-row snapshots, actual tool results, unchanged captured artifact identities and post-reconnect launch/time relationships. It requires exactly **one Git commit per ticket**, **one continuation per ticket after release on the surviving launch**, **four committed stage submissions/outcomes total**, **no additional launch**, and **both tickets at unique open operator gates**. Reconnected sockets alone cannot pass.

## Actual crash and continuation observations

| Actor | Identity / observation |
|---|---|
| Fresh protocol-5 host | PID **3247738**, host `45def595-b5fb-4464-9c04-49e78f5d54d7`, unchanged across daemon restart |
| Original `dev/1` | PID/PGID **3247750**, launch `e240fb4d-007c-4dcb-84bc-e40fa1a341ac`; owner/marker/UID-verified group SIGKILL at **02:58:33.279Z** |
| Replacement `dev/1` | PID/PGID **3247878**, launch `1b6db5c3-a88d-4e7e-bd7b-237844211968`; same logical assignment/conversation, inspected original commit, active held tool |
| Surviving `dev/2` | PID/PGID **3247756**, launch `26d91fc0-1ae0-4299-86dc-84e2bb2f32df`, unchanged |
| Daemons | First PID **3247703** SIGKILLed during both active tools; replacement PID **3247903** serves on same state root |
| Post-restart channel | Both then-live workers authenticate and send heartbeats within **5,413 ms**; no replacement launch or replayed work call |
| Release / continuation | Release at **02:58:39.768Z**, after reconnect proof; exactly two subsequent continuation records from the same surviving launches, then actual successful production tool results |

Each worker's initial tool had already completed its Git side effect before the first crash. Exactly three `work-call`/`held` records exist: two original calls and the killed worker's explicit inspect/resume call. Exactly **two commit-attempts, two commits, one inspected-existing-commit and two post-release continuations** exist. No fresh work call or new launch appears because of the daemon restart. The original killed tool never finishes; its replacement continues the same tracked work after inspecting that completed effect.

| Ticket | Initial repository head | Only committed effect after both crashes | Final tracked state |
|---|---|---|---|
| 1 | `89021121f2b68db25fa7628d4e2633645aa968b9` | `a98bf606ab3f1ca6c771b3c40d3e5715daccdd29`, one assignment-specific line | `gate / awaiting_approval`, one open approval |
| 2 | same | `0f2f7859b6238de50f567dbd28bad1ef2ed93bcb`, one assignment-specific line | `gate / awaiting_approval`, one open approval |

Before daemon restart, **5 accepted messages** are retained, including two ordinary operator markers, the original assignment contexts and worker-recovery notice. Message sequences **2** (ticket 2's assignment context, bound `dev/2`) and **5** (`FOU124_BEFORE_DAEMON`, bound `dev/1`) are still **sent/unacknowledged**. After continuation, all five original IDs/bodies/recipients/bindings remain and are acknowledged. Both ordinary marker bodies appear in actual Pi input/context observations. Two additional gate-assignment messages are also acknowledged: **7 total**. This is pending accepted work becoming processed, not merely an already-acknowledged row surviving on disk.

Both original implement assignments retain their IDs, ticket/slot/context bindings and finish exactly once with `end_reason=done`. Each ticket has exactly two ended/done assignments (implement and gate), one done transition for each stage, and one unique open stage approval. Four `task_transition` submission rows store the committed results; four successful corresponding real Pi tool results are observed. Paths, branch/worktree identity, source commit, spec hashes, committed file contents and prepared Git heads are identical before worker kill and after continuation. Only legitimate new continuation evidence is added; it is not incorrectly required to be byte-unchanged.

## Per-criterion proof and limits

| Original criterion / requested observation | Result and proof |
|---|---|
| Disposable repo + real Pi faux workers; worker kill/replacement then daemon crash during active work | **Verified** by actual launcher/tool journal, owned group signal, host inventory and channel records |
| Durable accepted messages, including pending work, with preserved binding | **Verified**: all 5 pre-crash IDs/bodies/recipients/bindings retained and acknowledged; actual ordinary marker processing and both downstream gate contexts observed |
| No lost tracked work and successful continuation | **Verified for this journey**: both original assignments honored and ended/done, both tickets progress to unique operator approval gates through committed production tool calls; no ticket, context or approval is missing |
| No duplicate committed effects | **Verified for these effects**: exactly one Git revision/body line/attempt/commit per ticket; 4 daemon-committed stage submissions and exactly one done transition per ticket/stage; no extra launch, tool replay or continuation |
| Appropriate worker and daemon recovery | **Verified**: inspect/resume on worker replacement; same then-live launches/host reconnect and continue after daemon restart, not just traffic-only survival |
| Artifact identity and isolation | **Verified** for captured paths/spec hashes/worktree/branch/committed heads and bodies across both crashes |
| Safe owned cleanup | **Verified**: orderly shutdown exit 0, zero pre-fallback marked processes/live group members, no fallback needed, private root removed and all 3 recorded PGIDs independently return ESRCH |

Within this exercised original journey no criterion is observed unmet. **Independent review is pending; the live issue is not changed to Done here.** The observation establishes successful continuation to the operator boundary, not full ticket integration/completion of PRD §18.1(1). It does not prove arbitrary external side effects exactly-once at every possible instruction boundary, malicious workers, host death/reboot, SIGKILL during an in-flight Git commit, remote services, SDK qualification, macOS or the full P0 release bar. It neither changes the product contract nor substitutes these limits for the original positive criterion.

## Verification tiers and final checks

The manual actual-process probe is explicit **E2E**, outside the commit suite: only daemon → host → real Pi → extension channel → store wiring can prove this journey. The pure `node:test` oracle/history/ownership cases use literal observations and negative mutations, without processes, database, filesystem fixtures, sockets, timers or sleeps.

**29 pure cases pass**: valid full observations, Pi custom-history projection, proc UID parsing, initially unbound acceptance binding once, 24 negative observation mutations, and all required/missing/extra-invariant verdict paths. Mutations include lost/rerouted/unacknowledged messages, changed artifacts, lost/rerouted assignments, no gate progression/approval, duplicate transition, duplicate Git/body/attempt/daemon commit, wrong SHA, absent/early/wrong-launch continuation, missing observations, foreign effects and extra launches. Every required observation missing or false fails even if reconnect passes.

Final normal checks on product base `a61daf0` use a short private home-backed TMPDIR and an `env -i` allowlist containing only PATH, private HOME and TMPDIR; **FOUNDRY_PI_BIN unset, no shim**, runtime override absent. Commands and explicit exits/environment/cleanup are in `checks/status.json`:

| Command | Final result |
|---|---|
| `npm ci` | exit 0 |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| direct `./node_modules/.bin/oxlint` | exit 0, no diagnostics |
| `npm test` | exit 0, **105 files / 862 tests passed** |
| separate normal `npm run test:e2e` | exit 0, **3 files / 5 tests passed** |
| `node --test docs/evidence/worker-daemon-crash-postmerge/verify.test.mjs` | exit 0, **29 passed** |
| requested final actual journey | exit 0, **20 / 20 observations true** |
| staged `git diff --check` | exit 0 |

An earlier ordinary full-suite attempt exited 1 with **104 files / 861 tests passed**, plus one Vitest worker unexpectedly SIGKILLed during startup for `packages/extension/test/import.test.ts`; no assertion failed and the cause was not established. Its complete log is retained. A focused unchanged import test passed (**1/1**) and subsequent unchanged normal full runs passed **862/862**. No timeout, assertion, suite configuration or product code was changed to obtain the green run.

## Retained preliminary fixture failures, normalization and cleanup

All retained output is explicitly **normalized evidence**, not byte-for-byte raw: personal home/checkout prefixes become `<USER_HOME>` / `<CHECKOUT>`, unrelated inherited PATH is redacted consistently across duplicate JSON/log/argv paths. Versions, IDs, order, times and relative relationships remain; captured runtime/source hashes refer to original bytes. Published `.log` trailing whitespace/terminal blank lines are canonicalized. DB/WAL snapshots were read only on copies after daemon exit; binaries are not committed. No live database was opened by the evidence reader.

The independent run is reproducible from `run-probe.mjs`, `worker.mjs`, `history.mjs`, `verify.mjs`, `verify.test.mjs`. Full positive outputs are under `run/`: final result/checks, normalized stdout, effective YAML, observer journal/launcher argv, daemon/host logs, before-restart/after-continuation rows, independent Git revision logs/diffs, actual continuation records and copied ticket specs/evidence. Source hashes pin the exact exercised additions. Guarded cleanup/normalization are reused from the committed historical harness without modifying it. `SHA256SUMS` covers the published report/sources/artifacts; check it from the repository root with `sha256sum -c docs/evidence/worker-daemon-crash-postmerge/SHA256SUMS`. A separate read-only replay of the normalized continuation artifact reproduces all 9 continuation predicates and the 20-check verdict, and verifies the killed/replacement conversation identity.

`preliminary/` preserves attempts rather than hiding fixture mistakes:

1. **ownership-guard:** an over-escaped UID regex refused the first signal before any worker crash. Marker cleanup also safely refused; a separately recorded marker/UID/mode-verified cleanup removed only that run's remaining processes/root. Pure tab/space/missing/different-UID cases now cover the corrected helper. Not a product failure.
2. **queued-notice-observer:** replacement channel/recovery notice were accepted and acknowledged, but the fixture watched only `before_agent_start`. A queued custom notice joined an already-running ordinary turn, so the faux worker did not inspect/resume. The real context-boundary observer was added, as in the existing concurrent fixture. Not a missing product notice.
3. **custom-history-observer:** that observer initially indexed only ordinary `message` entries, mistaking restored `custom_message` history for new fresh instructions and itself asking Pi to create an extra commit under a new call ID. The incomplete journey was nonzero, not accepted. History projection was corrected and given a cheap regression; the intentionally non-idempotent tool remains unchanged. This is a fixture-model error, not evidence that Foundry replayed a completed tool.
4. **before-stricter-oracle:** an initial positive run on `089ab52` passed the earlier 19 checks. Before finalizing, independent chronology/surviving-launch/extra-launch/foreign-effect requirements were tightened; the final real journey was rerun on latest `a61daf0` and all 20 stricter observations passed. Only the latter is the final positive acceptance candidate.

Each failed fixture run's owned processes/root was cleaned up; their failure manifests remain honest (the first one's supplemental cleanup is separate). The positive final run needs **no forced fallback**: both normal shutdown commands/daemon exit and pre-fallback/final process/group observations establish orderly removal. Independent post-run signal-0 probes return **ESRCH** for PGIDs 3247750, 3247756 and 3247878. The validation root likewise has zero remaining private-root processes before removal. Output copies and transient binary snapshots were removed only from the exact owned output roots after publication. No unrelated scratch, configuration/cache or operator host was touched.
