# FOU-124 — combined worker/daemon crash journey (Linux)

Ticket: [FOU-124](https://linear.app/foundry-mdl/issue/FOU-124/prove-worker-and-daemon-crash-durability-together). Contract: PRD §18.1(4): killing a worker and restarting the daemon mid-run loses no accepted messages or tracked work.

**Still blocked, not accepted.** After the evidence-fixture review fixes, a fresh real-Pi journey on latest develop again reaches the missing-reconnect boundary: the killed worker is replaced successfully, then the daemon is SIGKILLed/restarted while both workers are active. Both surviving workers retain their launch identities but neither reconnects or sends channel frames within **45,324 ms**. Persisted records are not a proof of recovered execution or exactly-once committed effects. The live criterion remains unchecked/In Progress; dependent [FOU-140](https://linear.app/foundry-mdl/issue/FOU-140) is not unblocked. No PR, tracker state, shared testkit or production runtime change was made.

## Evidence handling — normalized, not byte-for-byte raw

All retained historical/current transcripts, JSON, YAML and process logs are **normalized evidence copies**, not byte-for-byte raw output. `normalize.mjs` removes unrelated inherited `PATH` contents and consistently replaces personal T3 checkout prefixes with `<CHECKOUT>` and the real user-home prefix with `<USER_HOME>`. Executable suffixes, versions, ordered arguments, fixture-relative relationships, times, IDs and observed outcomes are preserved across duplicates. A tokenized path describes the original runtime relationship; it is not a runnable path. Original runtime hashes (spec/config/source hashes) are preserved, not recomputed over tokenized strings. SQLite DB/WAL copies are local-only and are not committed. Published regression/reviewer `.log` copies also have trailing whitespace and redundant terminal blank lines removed; diagnostics and counts are unchanged.

The first historical full Vitest ENOSPC log was trimmed from 2,919 lines to representative diagnostics plus the result counts; `checks/historical-trim.json` records original-source SHA-256, source commit and retained inclusive line ranges. Repetition is not evidence of additional independent failures. Representative independent reviewer diagnostics are retained under `reviewer-diagnostics/`, including exact `/tmp/jiti` ENOSPC messages, timeout counts, source hashes and a selected-event probe excerpt. The reviewer directory was read/copied only, not deleted or modified.

## Review fixes and scope

- **M1 — private short TMPDIR propagation.** The probe now creates a private, short home-backed `f124-*` root (mkdtemp mode 0700), with its own `t` temp directory. `TMPDIR` is explicitly present in the daemon child environment allowlist, rather than relying on an outer variable that was previously dropped. `/proc/<pid>/environ` verifies the exact directory on daemon → detached host → both Pi workers, and again on the replacement worker. Worker launcher records include both `process.env.TMPDIR` and Node's effective `tmpdir()`. The fresh run verifies all observations, reaches both crashes and cleans up the private root. No unrelated temp deletion, global cache edit or configuration change.
- **M2 — fail-closed bounded verdict.** `verdict.mjs` requires every mandatory observation and every additional recorded invariant to be exactly `true`; missing/false observations are listed in `failedInvariants`. Data/identity loss is `blocked-invariant`, missing channel recovery alone is `blocked-reconnect`, and an incomplete journey is `blocked-first-failure`. Exit 0 means only `bounded-pass-not-ticket-acceptance`; `fullTicketAcceptance` is always false. No reconnect/traffic/cleanup success can mask a failed persistence/artifact/assignment/launch invariant.
- **M3 — normalized retained evidence.** Historical duplicate evidence was normalized as well as the fresh output. New version records redact PATH before publication; copied worker/host/daemon logs and snapshots are normalized at finalization. Representative failure diagnostics replace the repetitive historical ENOSPC dump. This document does not describe transformed output as raw.
- **Cleanup safety.** Daemon stop, marker sweep, each evidence-copy phase, failure snapshot, private-root removal and normalization are independently guarded. A failed stop/copy cannot skip subsequent marker-scoped cleanup or final-manifest publication. Cleanup-phase failures themselves fail the verdict. Failure snapshots are refused unless daemon exit is confirmed; roots are preserved if the marker sweep cannot establish zero survivors.
- **Cheapest regression tier.** `verdict.test.mjs` uses plain Node unit tests, no processes/database/filesystem fixtures/sleeps: each invariant false/missing, additional future invariants, incomplete journey, blocked classifications, non-acceptance of a bounded pass, normalization and injected stop/copy failures. The real journey remains explicit E2E because cheaper tiers cannot prove process wiring.

## Reproducible invocations

From the repository root, with the pinned dependencies installed:

```sh
npm ci
npm run build
# OUT must be a fresh writable output path; put it on disk, not inode-exhausted /tmp.
node docs/evidence/worker-daemon-crash-linux/run-probe.mjs "$OUT"
# Expected current result: exit 1, blocked-reconnect (NOT a passing acceptance test).
```

The standalone runner supplies its own private HOME/XDG/Pi/Foundry/temp directories and credential-free faux model. It does not need an outer TMPDIR, wrapper, operator configuration, credential, paid provider or network model call. Fresh retained invocation used output `<USER_HOME>/f124-results/fresh-latest`; its child root was `<USER_HOME>/f124-4aOzN4` and was removed.

For reproducible ordinary regression checks despite the testkit's child allowlist dropping outer TMPDIR:

```sh
node docs/evidence/worker-daemon-crash-linux/run-checks.mjs "$CHECK_OUT"
```

`run-checks.mjs` creates another private short home-backed root, with `t` for test-runner temporary fixtures and `p` for Pi transpiler/cache output. It runs exactly:

1. `npm run build`
2. `npm run typecheck`
3. direct `./node_modules/.bin/oxlint`
4. `node --test docs/evidence/worker-daemon-crash-linux/verdict.test.mjs`
5. `npm test`
6. `npm run test:e2e` (separate ordinary E2E tier)

The command environment is an explicit allowlist: inherited PATH (not published), private HOME, `TMPDIR=<private-root>/t`, `FOUNDRY_PI_BIN=<private-root>/pi`. The generated shell wrapper exports `<private-root>/p` as TMPDIR and `exec`s the unchanged pinned Pi CLI using the exact Node executable and original ordered `"$@"` arguments. This is supported by existing testkit `resolvePiBin()` and host `resolvePiExecutable()` override seams; it does **not** patch shared helpers or bypass Pi/Foundry logic. The generated normalized wrapper and exact environment/commands/exits are retained in `checks-review/`. Wrapper invocations are observed and checked against the private temp directory. After all commands, only exact private TMPDIR markers are eligible for cleanup; the private root is removed only with no survivors.

The independent review's ordinary interrupt E2E timeout was accompanied by an explicit extension-load failure writing `/tmp/jiti/fixtures-interrupt-worker...mjs`; an outer disk-backed TMPDIR alone did not reach that child. The supported wrapper restores only this missing environment variable. This diagnosis applies to those retained diagnostics, **not to every historical timeout**.

## Fresh journey: versions and observations

Fresh run: **2026-11-26 UTC**, Linux x64, kernel `7.2.15-1-omarchy`, Node **v22.23.2**, pinned Pi **1.6.0**. Latest develop/production-code base: **`6dc2a5b5f01b9be13d465bccecedc67f04e8410c`**. Version record identifies rebased branch head `f184e23eeb272c672ee4e035d8bc006aaa35a1b2` plus the uncommitted evidence-fixture changes; that head has the same production code as latest develop. SHA-256 digests pin the exact runner/observer/verdict/normalizer sources. Latest develop advanced with evidence-only work while review corrections were underway, so the final checks and representative full crash journey were rerun on that latest base; the earlier fixed run is summarized in `run-current/reproduction-history.json`. The real default **RPC** launcher was used, not the SDK trial. Actual ordered argv/executable/cwd and private TMPDIR values are in `run-current/worker-events/worker.jsonl`.

Effective fixture: one disposable factory `alpha`, two instances of station `eng.dev`, model `foundry-faux/scripted` from the existing testkit faux provider, existing `concurrent-worker.ts` held-work tool wrapped only by the evidence observer. Two tickets have independent worktrees in writing stage `a`; stage `b` is an operator approval gate. Production daemon → detached Worker Host → pinned Pi `dist/bundle/rpc-entry.js --mode rpc` → production Foundry extension carries assignments, notices and channel frames. Full launch argv retains explicit tool set, model, resource flags, conversation ID and extension paths. Ambient extensions/MCP/skills/templates/themes/context files/approval prompts are disabled by the unchanged launcher. No ticket is released for completion/integration.

1. Both CLI-submitted tickets become assigned and both actual Pi workers enter `fixture_work`, writing their ticket-number markers then waiting for operator release or abort. Capture spec SHA-256, ticket/spec/evidence paths, branch/worktree identities and Git head.
2. Accept ordinary message `FOU124_ACCEPTED_BEFORE_WORKER_KILL` through the CLI. Inspect binding/status from the closed-database snapshots rather than treating the CLI's initial unbound response as binding proof.
3. SIGKILL original `dev/1` PID **2750018**, launch `5071c5f8-e41f-4a46-96c6-4dcd33051811`. Expected: same logical slot/conversation/assignment/artifacts, new worker and recovery warning. Observed: replacement PID **2750200**, launch `387dbbd6-6e90-42df-bdaa-d63038fc0610`, accepted channel and actual held-work call, same assignment/conversation, acknowledged resume warning and ticket 1 recovery count 1. Replacement inherits private TMPDIR.
4. During active work, SIGKILL daemon PID **2749971**, copy its closed DB/WAL for read-only row evidence, restart on the same home (new daemon PID **2750238**). Expected: both live workers reconnect and continue recovery. Observed over **45,324 ms**: **zero channel accepts and zero channel frames** from either live worker. Host PID **2750005**, surviving `dev/2` PID **2750025** / launch `6fd54aa1-6f33-4e9f-8722-d7f06ff78ddd`, and replacement `dev/1` PID/launch remain live and unchanged. Restart logs report the slots running; no replacement masks missing reconnect.
5. Stop at that reproducible product failure. After snapshots, marker-scoped cleanup finds **zero survivors**, every guarded phase succeeds, and the private run root is removed. Final verdict: **exit 1, blocked-reconnect**; only `survivingWorkersReconnected` and `channelTrafficResumed` are failed invariants. The other 9 observations are true.

All four accepted message rows preserve IDs, bodies and slot bindings; both active assignments remain tracked. Captured ticket paths/spec hashes/worktree identities/branches/started markers are unchanged. Both Git heads remain initial fixture commit `c091c8981715f2b6841aa3182fcc03d8bba7274a`. A sent assignment-context message remains `sent`, not recovered/acknowledged; the ordinary operator message is already acknowledged before daemon restart. This does not separately prove pending operator-message delivery after restart.

## Acceptance accounting and disposition

| Original outcome / requested observation | Result | Limit / owner |
|---|---|---|
| Disposable repo, real Pi faux workers, combined crashes during active work | **Verified on Linux** | Fresh normalized CLI, process inventory, launcher/tool and channel evidence |
| Bound accepted work persists | **Verified persistence only** | 4 messages with unchanged IDs/bodies/bindings; 2 active assignments |
| Ticket artifacts remain attached/unchanged | **Verified for captured fixture artifacts** | Paths, spec hashes, worktree/branch identity, Git heads and started marker contents |
| Appropriate recovery after worker death | **Verified for held-work fixture** | Replacement channel/tool call, same conversation/assignment, acknowledged resume warning |
| Appropriate recovery after daemon restart | **Unmet** | Both live workers fail to reconnect/send frames in bounded window; shared extension redial prerequisite tracked by [FOU-83](https://linear.app/foundry-mdl/issue/FOU-83/check-rpc-survival-and-reconnect-on-linux) |
| Real Pi E2E: durable accepted work, no lost tracked work, no duplicate committed effects | **Unmet overall; successful continuation and exactly-once committed effects unverified** | Record persistence is not recovered execution. Fixture does not commit an implementation or transition complete; unchanged initial heads are not an exactly-once proof. Original owner remains FOU-124, not Done |
| SDK/macOS crash qualification | **Unverified/out of this Linux fixture run** | No SDK or macOS crash journey performed |

**Disposition:** resume the existing ticket's evidence corrections, then wait on the existing reconnect prerequisite; do not create a duplicate reconnect investigation or expand this evidence ticket into shared recovery implementation. [FOU-94's connected-channel notice proof](https://github.com/markdlabrecque/foundry/pull/135) is not an extension reconnect fix. [FOU-147's explicitly selected SDK trial](sdk-147-trial.md) leaves shared extension redial unchanged. Neither the green ordinary suite nor the evidence-only branch is permission to mark this criterion Done or unblock FOU-140.

## Artifacts and final regression results

- Current probe and normalized evidence: `worker-daemon-crash-linux/run-current/`: `result.json`, `stdout.log`, effective `factory.yaml`, launcher/tool journal, daemon/host logs, before/after row snapshots and copied ticket specs/evidence. `NORMALIZATION.md` labels transformed output.
- Evidence code: `run-probe.mjs`, `worker.ts`, `verdict.mjs`, `verdict.test.mjs`, `normalize.mjs`; reproducible regression wrapper generator: `run-checks.mjs`.
- Final develop-base checks under `checks-review/`: **build exit 0; typecheck exit 0; direct oxlint exit 0 (empty diagnostics); 16 plain Node evidence unit tests passed; full Vitest exit 0, 100 files / 837 tests passed; separate ordinary E2E exit 0, 3 files / 5 tests passed**. Private wrapper invocations, cleanup observations and exact commands/env are in `checks-review/status.json`. These do not override the blocked requested crash journey. `unit-nested-home-before-fix.log` preserves an intermediate normalization unit failure under the check runner's nested private HOME; the path normalizer was corrected and all 16 final unit tests pass.
- Historical run `run/` remains valid on base `40ea1faff294990789b3fd92119c10146bc8978a`: worker replacement succeeds, daemon reconnect fails over 45,308 ms. Its paths/transcripts are now consistently normalized. `preliminary/` preserves the earlier incorrect activity-frame observer attempt (fixture error, not a product gate result). `checks/` preserves original checks/counts with a trimmed representative ENOSPC log. Historical ordinary-suite results were 837 commit-tier tests and 5 E2E tests passing after using outer disk TMPDIR; that past success alone was not reproducibility proof for children that drop TMPDIR.
