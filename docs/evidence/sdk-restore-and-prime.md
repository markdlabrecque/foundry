# SDK restoration and three prime situations — Linux

FOU-148, draft 56b. Contract: [PRD §17.2](../../prd.md#172-launch-gates-not-yet-passed), SDK fallback's additional restoration/channel/priming requirement, and §5.5. **Evidence tooling only; no product or shared testkit changes.**

## Verdict and limits

**Supported on the tested Linux implementation, after correcting two fail-closed verifier gaps and rerunning the actual SDK probe.** The real daemon → detached Worker Host → pinned Pi SDK worker reopened the same on-disk conversation after worker exit without replaying its completed disposable side effect. Fresh, recovery and manual idle in-place compaction primes appeared in model history. Final success was withheld until orderly shutdown, empty pre-fallback process/group observations and verified disposable-root removal.

This is **not full SDK launcher qualification**. No claims for macOS, daemon-kill survival/reconnect, automatic/busy compaction boundaries, interrupted execution resumption or other §17.2 gates. The known shared extension redial failure remains unchanged. Manual idle compaction is the narrow compaction observation here.

| Criterion | Final verified observation |
|---|---|
| Working extension channel | Both actual SDK launches accepted through host-authenticated identity. Operator work delivered/acknowledged; restored faux model called real `agent_discover`, receiving a committed result for factory `restore`, slot `dev/1`. Driver never directly invokes its implementation. |
| Same conversation after exit | First marked group killed, host reports exit, scheduler starts a different launch. Its `session_start` opens the identical SDK session ID/file, with prior prime, message, assistant tool call, result and final answer already present. Subsequent model input retains `ONCE_RESULT_148`. |
| No completed execution replay | Exactly one independent `side-effect` execution marker and one original `probe_once` call/result. Still one after restoration, further work and compaction. Replacement idle negative control makes zero model requests before recovered work is sent. This does **not** establish interrupted-tool resumption or arbitrary external-effect semantics. |
| Fresh | One `fresh` prime. One-second idle control: no model request and no session file; prime remains unacknowledged until first work turn persists it. |
| Recovery | Acknowledged prior prime plus new launch, same conversation: one acknowledged `recovery` prime, no automatic work turn. Next delivered turn's model history includes it. |
| Manual idle in-place compaction | Real SDK `ctx.compact()` → faux summary call → one `session_compact` (`manual`) → one acknowledged `compaction` prime. PID/launch/conversation unchanged. Prime alone starts no work turn; next delivered turn includes it. |
| Correct full prime content | Actual disk entries equal observer branch entries. Each of three disk primes independently checked against fixture address, slot, isolation and knowledge conventions, ordered factory → room → station source paths, contents and SHA-256 hashes. Each matches its store situation, slot, conversation, ID, ordered parts and acknowledgement. Five operator messages acknowledged. |
| Orderly, owned cleanup | Shutdown command succeeded; daemon exited. Pre-fallback and final observations contain zero marked processes and no live members in either recorded worker group. `fallbackUsed: false`, `orderly: true`, `rootRemoved: true`. Removal verified with a separate existence check. Only intentionally killed group was marker-verified immediately before the signal. |

Unmet within this exercised narrow scope: none. All broader limits above remain unverified. Independent review reproduced the narrow behavior before these verifier changes; **fresh review of these fixes is pending**.

## Review must-fixes and pure red/green proof

The original observations were correct, but the old driver could falsely green other runs. Earlier artifacts are retained as historical observations, **not current verifier qualification**.

### M1 — cleanup must decide the final verdict

Previously `supported` was assigned before cleanup; a shutdown exception or surviving group could be recorded, swept away by fallback, and still exit zero. The evidence-only `verifyCleanup` seam now:

1. catches/records shutdown and observation errors without skipping safe owned fallback;
2. rejects any pre-fallback marked process or live recorded-group member, even if fallback later removes it;
3. marks fallback use as non-orderly, never as recovery to success;
4. checks final processes/groups, removes the root only when safe, and independently verifies its absence;
5. permits `supported` only after all cleanup checks pass. Any cleanup error, survivor, fallback use or unverified removal produces `inconclusive-orderly-cleanup` and **nonzero exit**. Earlier behavioral observations remain separately labeled `behavioralOutcome`.

Pure stubs cover clean shutdown, shutdown exception, survivor removed by fallback, group survivor absent from the marked-PID list, root still present, survivor persisting after fallback, the reviewer's combined shutdown-exception/live-group case, and snapshot exceptions. No regression starts a process or sends a signal.

### M2 — equal wrong primes must not pass

The old check accepted three mutually equal but identically wrong bodies/parts. The independent oracle now reads the disposable fixture's ordered `factory.md`, `room.md`, `station.md` contents and hashes them with Node SHA-256; it never takes expected hashes/order/header values from a prime or imports Foundry's composer. It checks the full contract header/conventions and complete ordered attributed bodies against **on-disk SDK custom entries**, then checks matching store records.

A literal golden prime and hashes were copied from previously correct observed output, not generated by the verifier under test. Negative mutations change all three bodies together: wrong address, slot, isolation convention, knowledge root, reordered blocks with matching reordered store parts, bogus hash with matching store parts, wrong source path, and inconsistent store situation. Thus mutual agreement cannot hide a wrong result.

- Red: extracted pre-review checks exercised by the first 17 pure cases; **exit 1, 16 failures / 1 pass**. Includes the two reproduced false-green classes. `checks/unit-red.log` is intentionally failing evidence, not a current suite failure.
- Green: fixed checks plus a normalization-relation case; **exit 0, 18/18 passed** in milliseconds. `checks/unit-green.log`.
- The reusable manual process probe is still outside commit-tier Vitest. These cheap verdict/oracle regressions are pure `node:test`; no timing retries, bootstrap, filesystem, process or network work is duplicated there.

```sh
node --test docs/evidence/sdk-restore-and-prime/probe-verification.test.mjs
```

## Retained artifacts and normalization

**All report commands and retained JSON/log output are normalized, not literal raw host output.** Machine-specific path prefixes are presentation placeholders:

| Placeholder | Meaning |
|---|---|
| `<repo>` | This checkout root; package-relative executable/module/source paths preserved |
| `<node>` | Actual Node executable, version `v22.23.2` |
| `<node-bin>` | Directory containing that executable (e.g. PATH entry) |
| `<fixture>` | That run's freshly created disposable root |
| `<private-tmp>` | Short private disk-backed temp directory under the user's home |
| `<home>` | Remaining unnecessary user-home prefix |

Mappings apply consistently inside JSON, nested JSONL strings, argv, model context, session entries and diagnostics. IDs, timestamps, versions, argv order, package identity and relative source relationships are preserved. Deterministic repeated padding alone is abbreviated as `[deterministic padding: 48000 z characters]`. Placeholders are **not shell variables** or real paths; choose local paths when reproducing. No secrets entered any run.

Files under [`sdk-restore-and-prime/`](sdk-restore-and-prime/):

- `run-probe.mjs`: bounded manual driver using actual product scheduling/reconciliation/primer/channel/persistence. Reuses sibling [RPC argv recorder](rpc-53-3-linux/fixtures/record-argv.mjs).
- `fixture.mjs`: explicitly configured faux provider, disposable append-only effect, lifecycle/model-input observer. A marked request asks the real extension API for manual idle compaction; it synthesizes neither compaction events nor primes.
- `probe-verification.mjs`, `probe-verification.test.mjs`: independent pure cleanup verdict/prime oracle and regressions.
- `normalize-evidence.mjs`: presentation-prefix normalization only; does not change runtime behavior or assertions.
- `result.json`: **fixed-driver actual passing run**, including versions/env/argv/effective YAML/validation, store rows, expectations derived from source files, observer JSONL, actual SDK session JSONL, process identities and final cleanup proof.
- `earlier-supported-result.json`: pre-review historical positive observations; not evidence that the old verifier was fail-closed.
- `checks/`: explicit exits/counts, red/green proof and build/typecheck/direct-lint/full-Vitest/separate-e2e logs. Historical e2e environment timeout is retained.
- `observation-errors/`: historical YAML-key mistake, wrong observer-event assumption and `/tmp` inode exhaustion; not SDK failures.

## Reproduction and effective fixture

Use a **short private disk-backed parent and child TMPDIR**, not `/tmp` on this host. The driver explicitly forwards child `TMPDIR` inside `<fixture>` and selects `FOUNDRY_WORKER_RUNTIME=sdk`. `FOUNDRY_PI_BIN` is **absent** in the SDK evidence environment.

```sh
npm ci && npm run build
private_tmp=$(mktemp -d "$HOME/p148-XXXXXX")
TMPDIR="$private_tmp" node docs/evidence/sdk-restore-and-prime/run-probe.mjs "$private_tmp/output"
# Read output/result.json, then remove only your owned private directory.
```

The driver creates disposable HOME, XDG roots, agent/state/session dirs, Git source/worktree/knowledge roots and provider fixture. Environment is allowlisted (PATH only inherited); fixture Git commits disable hooks. No real `~/.pi`, global config, production, operator resources, 1Password, credentials, network provider or paid model. Read-only SQLite observations use `node:sqlite`.

Product base: `050145655c76a722afc6bce70ae422397e49872c`, latest `origin/develop` after fetch/rebase, SDK adapter merged. Fixed-run checkout head: `078a1ee351bee9d86bf190f12ab6f11c4ce2111b` plus uncommitted evidence-only review fixes. Implementation agent `openai/gpt-6.1-sol`.

- Linux: `Linux omarchy 7.2.15-1-omarchy #1 SMP PREEMPT_DYNAMIC Mon, 02 Nov 2026 10:32:17 +0000 x86_64 GNU/Linux`.
- Node `v22.23.2`, npm `10.9.8`, repository-pinned Pi `1.6.0`.
- Fixed actual run: 2026-11-26 around `01:07:23Z`–`01:07:32Z`; event timestamps retained. Vitest separately prints local host time.
- Factory `restore`, station `eng.dev`, slot `dev/1`, `isolation: worktree`.
- Model `restore-probe/scripted`, credential-free pi-ai faux provider, context 128000, maxTokens 4096. Fixture tool `probe_once` plus fixed Foundry tools.
- Instructions: `factory.md`, `room.md`, `station.md`, respectively `FACTORY_INSTRUCTION_148\n`, `ROOM_INSTRUCTION_148\n`, `STATION_INSTRUCTION_148\n`. `result.primeExpectation` records the independent ordered inputs. Hashes and full bodies are retained in store/session records.
- SDK default in-memory compaction settings unchanged. Two turns (`PAD_A_148`, `PAD_B_148`) each deliver 48,000 `z` characters, establishing multiple spans and a cut point beyond default 20k kept tokens. Then actual manual idle compaction uses the faux summary response. No automatic or busy-boundary claim.

Normalized actual daemon command (`result.launchCommand`):

```text
<node> <repo>/packages/daemon/dist/main.js --home <fixture>/state <fixture>/factory.yaml
```

Actual host-launched worker argv retains `<repo>/packages/host/dist/sdk-worker.js`, explicit cleared ambient resources/system prompts, conversation ID, model, fixed plus named tool list, built Foundry extension and fixture extension. The inherited `--mode rpc` flag is host-resource compatibility syntax; the SDK worker does not run an RPC stdin command stream. Recorder `NODE_OPTIONS=--import=<repo>/docs/evidence/rpc-53-3-linux/fixtures/record-argv.mjs` only observes argv/output.

| State | Launch | PID / PGID | Conversation |
|---|---|---|---|
| Fresh | `709723c7-5a41-417d-a9c9-94717e0383f8` | `2664921` / `2664921` | `4960541b-e92d-40fe-8d12-1ff75b1ab53c` |
| Recovery and compaction | `46f41bc7-5efa-464e-a773-6dd5ad8737d2` | `2664966` / `2664966` | same |

Sequence: accepted fresh channel → idle prime (no turn/file) → delivered `FIRST_148` → `probe_once` / `ONCE_RESULT_148` → `DONE_FIRST_148` and receipts → marker-verified group SIGKILL → replacement opens same disk history → recovery prime/receipt without execution → delivered `RECOVERED_148` → authenticated `agent_discover` → two padding turns → real manual compaction → compaction prime/receipt, same launch → delivered `AFTER_COMPACT_148` includes prime → successful orderly shutdown → empty pre-fallback/final snapshots → removed root verified absent → final success.

Only live/non-zombie members count in recorded group checks. Fallback re-checks the unique `PROBE_DIR` marker on all live group members immediately before signaling; it never signals by process name or stale PID. A fallback may improve safety but necessarily fails this probe's orderly-cleanup observation.

## Environment and historical observation errors

Historical setup artifacts are retained and now path-normalized:

1. `observation-errors/yaml-key.json`: instructions wrongly at YAML root; validator rejected it. Fixture corrected to `defaults.instructions` and explicit disposable worktree root.
2. `observation-errors/wrong-observer-event.json`: observer expected `input`, but Foundry delivers a custom message. Channel delivery succeeded; the faux script failed to recognize work. Observer corrected to actual `before_agent_start.message`; no product fix or synthetic event.
3. `observation-errors/tmp-inodes.json`: Git initialization failed ENOSPC. `/tmp` had 22 GiB free but only 151 free inodes out of 1,048,576, later zero; independently confirmed by coordinating/review agents. Moved owned probes to short private disk-backed directories; no unrelated cleanup.

Initial separate e2e with parent TMPDIR alone: **1 failed interrupt timeout, 4 tests passed** (`checks/e2e.log`). The testkit drops child TMPDIR, so the TypeScript-extension child still encounters `/tmp`. No exposed child ENOSPC stack was captured: the environment attribution is supported by the private-child-temp control, not a claimed direct stack diagnosis.

No shared testkit change here: FOU-149 owns that remediation. Until it merges, the documented temporary shim sets **child TMPDIR only** and execs the same pinned Pi CLI with unchanged argv. This qualifies the e2e result's environment; the actual SDK probe never uses the shim or `FOUNDRY_PI_BIN`.

Normalized shim (substitute actual paths when creating a disposable local file):

```sh
#!/bin/sh
export TMPDIR='<private-tmp>'
exec '<node>' '<repo>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js' "$@"
```

Normalized e2e command:

```text
TMPDIR=<private-tmp> FOUNDRY_PI_BIN=<private-tmp>/pi-tmp ./node_modules/.bin/vitest run --config vitest.e2e.config.ts
```

## Final regression checks, independently classified

| Check | Result |
|---|---|
| Pure evidence regressions | **18/18 passed**, exit 0; initial legacy-check red run intentionally retained |
| Fixed actual disposable SDK probe | **Supported**, exit 0; orderly cleanup, no fallback, verified root absence |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| Direct `./node_modules/.bin/oxlint` | **exit 0**, explicitly captured; empty diagnostics |
| Full Vitest (private parent TMPDIR) | **100 files / 837 tests passed**, exit 0 |
| Separate e2e (private child-temp shim) | **3 files / 5 tests passed**, exit 0; 11.01 seconds |

The normal child-temp suite remains environment-qualified pending the separate shared fix; no testkit/product/test-configuration edits were made to make it pass. These checks do not substitute for the retained actual SDK observations.

Read alongside [SDK adapter trial](sdk-147-trial.md), [RPC Linux resource evidence](rpc-53-2-linux.md), [RPC process-group evidence](rpc-54-4-linux.md) and [Pi compaction events](compaction-event.md). No PR, merge or Linear change. Fresh independent review of the verifier fixes is required before qualification/closure decisions.
