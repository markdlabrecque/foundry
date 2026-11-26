# FOU-124 — bounded oracle corrections after independent REQUESTCHANGES

## Current disposition and provenance

The fresh independent review of `f380cd2c6c1161c04d30498c655000f0b8a16437` confirmed the actual positive journey and its recorded relationships, but returned **REQUESTCHANGES on the evidence oracle**, not the product. The old oracle accepted count-preserving corruptions of submissions/tool results/approvals/Git references, and missing downstream contexts or unexpected pending work. Those holes meant the earlier passing verdict was not sufficiently discriminating. This correction does not weaken or replace the original acceptance criterion.

**Disposition: bounded corrections implemented; stronger retained-artifact replay and fresh actual journey pass; NEW independent review required before PR creation.** No product/testkit/configuration change, subagent, PR, watch, merge, tracker closure or coordinator CURRENT edit. The separate FOU-83/149 and platform/release gates remain separate.

- Fetched `origin/develop` remains **`a61daf0913331e83cb111c6b6572a8a3bba2f434`**; no develop advancement/rebase was needed.
- Fresh execution checkout HEAD is **`f380cd2c6c1161c04d30498c655000f0b8a16437`**, containing the preceding evidence-only commit on that base. The strengthened oracle/test additions were uncommitted during validation. Exact exercised sources are pinned by the runtime SHA-256 and `checks/source-hashes.json`; the resulting commit wraps these same bytes. Product code is identical to develop base `a61daf0`.
- Fresh actual run: **2026-11-26 03:15:41.374–03:15:50.425 UTC**, Linux x64, Node v22.23.2, Pi 1.6.0, real default-RPC launch route and fresh control-protocol-5 host. No shim; FOUNDRY_PI_BIN unset. The unchanged runner records ordered argv, source pins, effective child environment/YAML, IDs/times and process/group cleanup.
- Old run, preliminary failures and old check logs are untouched. `before-review/` preserves exact pre-review oracle/test/history/report/checksum bytes from `f380cd2`; its historical checksum paths describe that original tree, not the revised working tree. Reviewer-owned `/home/mark/f124review-sd9dxc/` was neither read nor modified.

## What changed in the oracle

Only `verify.mjs`, its pure tests and evidence/report artifacts change:

1. **Bijection, not counts.** Exactly four unique expected assignments, four unique `(launch, call)` submissions and four unique actual production tool-result events must match one-to-one. Each matching event is tied to assignment, ticket, stage, factory, logical slot and a surviving launch whose stored factory/slot identity agrees. Each committed submission's parsed result, actual tool result details and text result must equal the independently expected assignment/ticket/next-stage/status value. Errors, stripped/malformed results, missing events or duplicates fail.
2. **Real gate references.** Two unique positive approval IDs must reference the correct gate assignment and its precise done transition sequence in the same factory/ticket. Gate committed results must return that exact approval ID. Done transitions have four unique sequences, correct actors/stage/status and one per expected assignment/stage.
3. **Git cross-links.** Both tool inputs' `gitCommit` and done transition `git_commit` must match independently captured ticket Git heads. Each observed Git base must match the original and final ticket `start_commit` and prepared worktree start commit; the head must match the prepared head. Existing one-revision/one-line/one-attempt/one-commit checks remain mandatory.
4. **All final contexts and accepted work.** Every final assignment, including both downstream gate assignments, must reference one acknowledged context message with matching factory, ticket, slot, recipient and assignment/stage/slot body. Final message IDs must be exactly the union of pre-restart accepted IDs and final assignment context IDs; every final message must be acknowledged and bound. Missing gate contexts, wrong bindings/bodies, or unexpected pending/extra work fail.

These strengthen the existing mandatory predicates without changing their names or allowing any formerly required observation to disappear. The final verdict still requires all **20** checks; the nine continuation predicates now enforce the cross-record relationships rather than accepting matching counts.

## Cheap red → green evidence

The cheapest sufficient tier for these holes is **pure unit**, with faithful literal Pi/store/Git observation shapes. No filesystem, process, database, network, bootstrap, sleep or retry occurs inside those tests. Real-process E2E remains a separate wiring proof, not another copy of oracle tests.

- **Red:** ran the new 54-case test source against the exact pre-review `f380cd2` oracle, using owned private copied files. **Exit 1: 29 pass, 25 fail**. All 25 added negative corruptions were incorrectly accepted by the old verdict, including all seven reviewer examples. `checks/red.log` is retained and pins the final new test source in `checks/status.json`.
- **Green:** same new test source against the revised oracle: **exit 0, 54/54 pass**. `checks/green.log` and the final `checks/unit.log` retain both invocations.
- Coverage now includes **49 targeted negative observation cases** (24 existing + 25 new), plus the valid observation, history projection, ownership, initially unbound-message positive and fail-closed verdict cases. The latter additionally exercises **40 false/missing required-flag mutations**, future false invariants and incomplete journey. No assertion or original criterion was weakened.
- Added corruptions cover stripped/wrong launch/call/factory/slot/result submission fields, unknown result assignment identity, wrong tool input Git SHA/details/text, invalid/duplicate approval IDs/references, wrong transition actor/Git, wrong Git base/start commit, missing/unacknowledged/misbound/misidentified gate contexts, and unexpected pending or acknowledged work.

Reproduce the green unit run from the repository root:

```sh
node --test docs/evidence/worker-daemon-crash-postmerge/verify.test.mjs
```

For red reproduction, copy the current `verify.test.mjs` and `history.mjs` into a fresh owned private directory, copy `review-fix/before-review/verify.mjs` there as `verify.mjs`, and run the same Node test command on that copied test. Expected exit is 1 with 25 failing rejection assertions. The original red copies/root were removed after the recorded run.

## Stronger replay and fresh actual positive journey

Read-only replay is now a reusable tool; it performs no worker/store actions and does not mutate input evidence:

```sh
node docs/evidence/worker-daemon-crash-postmerge/review-fix/replay.mjs docs/evidence/worker-daemon-crash-postmerge/run
node docs/evidence/worker-daemon-crash-postmerge/review-fix/replay.mjs docs/evidence/worker-daemon-crash-postmerge/review-fix/run
```

Both exit 0, with **9/9 strengthened continuation predicates and the 20-check verdict passing**. `checks/retained-replay.json` and `checks/fresh-replay.json` identify the exact replay oracle hash and verify all six captured runtime source pins. The old run's oracle pin resolves to its exact archived `before-review/verify.mjs`, not falsely to the modified current oracle. The fresh run's six pins all match current exercised sources. Final oracle SHA-256: **`d25b36e7d8a95b04944ed015fee04c092fe27d976d9bd4318985c3c505beaf9c`**.

The unchanged real-process runner was executed again after the normal build, with the stronger oracle and an explicitly private child TMPDIR. **Exit 0, all 20 checks true**, not just replay of the old evidence. Full fresh result, row snapshots, actual tool journal, Git log/diff/body evidence, YAML/argv, logs, specs and continuation evidence are under `run/` here.

| Original acceptance observation | Fresh evidence and limit |
|---|---|
| Worker replacement, then daemon restart during active work | Verified: owned worker group **3334884** killed; replacement **3335077** inspects existing effect; surviving worker **3334891** remains active; daemon killed/restarted while both tools held |
| Appropriate reconnect and successful continuation | Verified: same host PID **3334872** and then-live launches authenticate/send heartbeats within **5,413 ms**, then both tools continue after release; no extra launch/replay |
| Durable accepted work, including pending messages | Verified: pre-restart **5 IDs/bindings**, with sequences **2/5 still sent**, all preserved and acknowledged; final **7/7 messages acknowledged**, including both correctly bound gate contexts; no unexpected work |
| No lost tracked work | Verified: both original assignments end/done and their exact committed results advance to one gate assignment/outcome and unique referenced open operator approval each |
| No duplicate committed effects | Verified: exactly 2 external attempts/commits, 1 inspect, 2 continuations and 4 fully correlated production submissions/tool results/done outcomes; no unrelated/duplicate effect accepted |
| Correct Git/artifact identity | Verified: original/final start commits and worktree bases agree; all tool input/transition SHAs agree with prepared and observed heads; artifact bindings/specs/committed bodies remain unchanged |
| Owned cleanup | Verified: orderly shutdown, zero marked processes/live group members before fallback, no fallback required, private root removed; all 3 recorded PGIDs independently ESRCH |

Fresh disposable repository base: `43e991faca95f09ab75497740edbc1d90908cc4e`. Ticket 1's only effect is `02727e388994a1e4ab90959770f21402189b7216`; ticket 2's is `180231ecc0d2a473be2b2d1ddaca0b90a84faf75`. Both contain one assignment-specific committed line and preserve their prepared heads across both crashes. Four real task-transition input SHAs and stored transition SHAs tie to those heads; the oracle now verifies these relationships itself.

No original observation is unmet within this exercised fixture. **Independent acceptance of this revised evidence remains unverified pending a NEW review.** This is continuation to an operator gate, not full ticket integration, arbitrary external-call exactly-once at every instruction boundary, malicious-worker safety, SDK/macOS qualification or the full release gate.

## Final normal checks, hashes and cleanup

All final commands used `env -i` with only PATH, private HOME and a short private home-backed TMPDIR. FOUNDRY_PI_BIN and runtime override were absent; no shim or credential/provider environment was inherited. Existing dependencies were retained from the successful original `npm ci`; no lockfile/dependency change.

| Command / observation | Result |
|---|---|
| `npm run build` | exit 0; compiled output digests in `checks/build-hashes.json` |
| `npm run typecheck` | exit 0 |
| direct `./node_modules/.bin/oxlint` | exit 0, no diagnostics |
| unchanged full `npm test` | exit 0, **105 files / 862 tests** |
| separate unchanged `npm run test:e2e` | exit 0, **3 files / 5 tests** |
| evidence unit suite | exit 0, **54 tests** |
| strengthened retained/fresh read-only replay | both exit 0 |
| fresh actual combined-crash journey | exit 0, **20/20** |
| staged diff / complete published checksums | exit 0 |

`checks/status.json` records exact argv, exits, environment, bases, red/green counts and cleanup. Runtime and published source digests are separate from compiled output digests. The global updated `../SHA256SUMS` covers current report/source/artifact bytes; validate from repository root using `sha256sum -c docs/evidence/worker-daemon-crash-postmerge/SHA256SUMS`.

All new output is labeled normalized evidence, not byte-for-byte raw: personal home/checkout prefixes and unrelated PATH are normalized consistently; `.log` trailing whitespace is canonicalized before published checksums. Pre-review reports, logs, failures and the original blocked evidence remain preserved. No live DB was opened by the reader; copied DB/WAL binaries were excluded from publication and removed with the exact owned output root.

The final pre-fallback observation already has no marked process or live group member, and orderly shutdown is true. Independent signal-0 checks return **ESRCH** for PGIDs **3334884, 3334891, 3335077**. The private validation root has zero remaining processes before removal; only its exact UID/mode-verified root and the exact owned copied-output root were removed. No unrelated `/tmp`, cache/config, operator/old host or reviewer artifacts were touched. Stop here for NEW independent review; do not create a PR or alter the tracker.

## Submission addendum — independent approval, final fetch and evidence-only rebase

This later addendum supersedes the earlier pending-review/stop-before-PR disposition, **without changing any historical execution HEAD, dirty-working-tree source pin, original captured record, red/green result or cleanup claim above**.

The coordinator relayed the NEW fresh GPT-6.1-SOL re-review: **APPROVED `891c20b03b5c60d82934288bc4ebe3d990f2ad73`, no must-fix**. The independent reviewer reported a positive actual journey (20/20), 54 passing pure tests, the 29-pass/25-fail red run, 54 actual-record mutations against each of three artifacts (**162 rejections**), all 117 then-published checksums/source/build matches, and normal 862-test/5-E2E green checks. These are explicitly relayed independent review results, not a hosted GitHub approval or additional executions by this author. Optional integer-sequence schema hardening was nonblocking and is deferred; no oracle/test scope was added after approval.

Final fetch advanced develop from `a61daf0913331e83cb111c6b6572a8a3bba2f434` to **`dbc34d51ea84e1535f6d0fc212a1f2dd8c7f8f92`**. The full delta consists only of the separate `docs/evidence/linux-launcher-qualification*` report/artifacts: product, test, dependency and configuration bytes are equivalent. Both branch commits rebased cleanly, producing validation checkout **`3b10a556db4bef2b76a6d60296abd5982b15ba89`**. Before this addendum, the complete FOU-124 evidence subtree/report was byte-identical to approved `891c20b`; no oracle, test, runner, worker or captured artifact changed during rebase. `git merge-tree --write-tree origin/develop HEAD` succeeded and equalled the rebased HEAD tree, **`7366fb0071dd782d4d0af234c9d705696c4a89de`**.

Final normal checks were repeated after rebase using a fresh mode-0700 home-backed private root, `env -i` PATH/private HOME/private TMPDIR only, **FOUNDRY_PI_BIN unset, no shim**, and no runtime override:

| Final submission check | Result |
|---|---|
| build / typecheck / direct oxlint | all exit 0 |
| full ordinary Vitest | **105 files / 862 tests**, exit 0 |
| separate ordinary E2E | **3 files / 5 tests**, exit 0 |
| pure evidence suite | **54/54**, exit 0 |
| retained and fresh recorded-journey replay | both exit 0, 9 strengthened predicates and 20-check verdict pass |
| compiled output hashes | byte-identical to the independently approved run |
| approved publication manifest before addendum | **117/117** entries verify |
| updated final publication manifest / staged diff check | exit 0 |

`submission-checks/` retains exact command logs, both replay outputs, approved-manifest verification, merge-tree/base/delta/source-build evidence, environment, counts and cleanup in `status.json`. The final submission commit adds only this provenance addendum, these validation logs/metadata and refreshed publication checksums after the approved/rebased source tree. The final PR head is the commit wrapping those documentation-only changes; it is not misrepresented as the historical actual-run checkout `f380cd2` or the pre-addendum validation checkout `3b10a55`.

The new private validation root had zero remaining associated processes before removal; only that exact owned UID/mode-verified root was removed. No actual crash journey was repeated solely for an evidence-only base change: the independently reviewed 20/20 captures are retained and replayed with unchanged source hashes. Safety, observed continuation through an operator approval gate, and all bounded Linux/default-RPC limitations above remain unchanged. Open the PR against develop for **FOU-124 only**; no watch, merge, manual Linear closure, coordinator CURRENT edit or broader SDK/macOS/full-integration/release claim.
