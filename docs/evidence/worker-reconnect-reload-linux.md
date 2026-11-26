# Worker reconnect review correction — launch-permanent refusal

## Current candidate and review scope

P1 from independent GPT 6.1 SOL review of `71e13a6`: Pi's real `session.reload()`
reconstructs the Foundry extension and its tool client, losing the terminal
refusal retained only in the old instance. The initial positive process probes
were valid but did not exercise reload; they were not sufficient to establish
launch-permanent refusal. The [initial candidate report](worker-reconnect-linux.md)
and its failed hand-extracted retry baseline remain historical evidence, not
an untouched-base red observation or the current complete implementation.

Correction implementation after final rebase: **`8505ae69e923c06250ab714a5aca3e2e1827415b`**.
Fetched `origin/develop` is **`1bde222862fbf6d1d4ba311faa85cf62ee601c46`**.
Rebased without conflict onto the independently merged FOU-163 collision fix,
including host-control protocol 5. All final checks/probes below were rerun
**after** that rebase, using only fresh disposable hosts. The earlier pre-rebase
correction `cd4a7cb` and its 859-test run are superseded, not the final candidate. Fresh probes ran at the clean correction commit
(`versions.uncommitted: []`). The next evidence commit changes only reports and
artifacts. No SDK loader, host diagnostic, daemon collision or other FOU-163
implementation files were touched. No migration or operator configuration change.

## Correction and lifetime/cleanup rules

`packages/extension/src/channel/launch.ts` holds a versioned-symbol registry on
this Node process, keyed by the socket/factory/slot/launch identity tuple. This
is private volatile launch state, not disk/global operator configuration. The
same registry survives reconstruction of both the extension and its module.

- One current transport owner per active launch. Claiming an already-owned launch
  stops the previous owner's connection; old owners cannot release or poison a
  replacement's state.
- A terminal reason is retained as the first reason for that launch. The freshly
  constructed tool client is refused immediately with that exact code/detail,
  before any tool execution, and session start cannot dial that launch again.
- Every shutdown stops the old transport, timers and pending dial, and clears its
  stored stop closure. Reload/new/resume/fork preserve **only terminal metadata**;
  nonterminal entries are removed rather than accumulated.
- Quit removes the launch entry entirely. Process exit naturally frees the
  registry. Independent launch keys have independent refusal/ownership state.
  No old Pi context, client or transport callback is retained across a terminal
  reload; the record contains only the reason and ownership token until claimed.

The normal daemon-restart reconnect lifecycle, retained adapter/reconciliation
state, capped backoff and Tool Set/conversation checks are unchanged. No replay
or worker replacement behavior was introduced.

## Direct red–green reproduction

The reviewer supplied [this real pinned-Pi repro log](worker-reconnect-linux/review-fix/checks/reviewer-reload-repro.log):
first prompt receives `launch_not_current`, claims **1**, submissions **0**;
after `await session.reload()`, claims **2**, submissions **1**, unexpectedly
committed. The reviewer scratch was read only and was not modified or cleaned up.

The regression is in the existing `test/worker-refusal.test.ts` real-socket/Pi
fixture, not another full-process suite. It invokes actual `session.reload()`,
not merely a same-runner `session_start` event. Against unmodified production
code at `71e13a6`, it failed with **`expected 2 to be 1`** at the dial-count
assertion; the permissive second claim allowed a tool frame through. This is a
direct red against the reviewed implementation, separate from the earlier
hand-extracted retry-policy red baseline.

```sh
# From the feature checkout, private home-backed TMPDIR; no diagnostic shim:
TMPDIR="$HOME/f162-fix" env -u FOUNDRY_PI_BIN npx vitest run test/worker-refusal.test.ts -t 'actual Pi extension reconstruction'
# After the fix:
TMPDIR="$HOME/f162-fix" env -u FOUNDRY_PI_BIN npx vitest run test/worker-refusal.test.ts packages/extension/test/launch-state.test.ts packages/extension/test/reconnect.test.ts
```

[Red log](worker-reconnect-linux/review-fix/checks/reload-red.log) and
[focused green log](worker-reconnect-linux/review-fix/checks/focused-green.log)
retain the exact outcomes (machine checkout prefix normalized). The red command
selects one test; its three filtered-out cases are not skipped in full validation.
Green: **15 tests / 3 files**, including the actual reload regression proving:

1. Before reload: exact terminal error, no tool dispatch.
2. After reload: **one total dial**, **zero tool frames**, and the same explicit
   `launch_not_current: stale launch` code/detail in the tool result.
3. Two cheap new unit cases additionally prove module reconstruction retains the
   reason, independent launch keys are unpoisoned, quit releases retained state,
   takeover stops old transport ownership, and stale releases/refusals cannot
   alter the new owner. These do not bootstrap Pi, use sockets or sleep.

The optional direct unanswered-hello timeout regression was not added; the P1
fix does not modify that transport timeout. Existing timeout policy and all
previous reconnect/cancellation tests remain intact.

## Fresh actual RPC and SDK 52-1 probes

The unchanged entry points and effective fixtures documented in the
[original report](worker-reconnect-linux.md#exact-existing-probes-and-environment)
were read and reused. Commands run with the short, mode-0700, owner-marked
home-backed parent; child TMPDIR is explicitly propagated by the existing driver:

```sh
export TMPDIR="$HOME/f162-fix"
unset FOUNDRY_PI_BIN
FOUNDRY_WORKER_RUNTIME=sdk node docs/evidence/rpc-52-1-linux/run-probe.mjs "$TMPDIR/rpc-final"
node docs/evidence/sdk-52-1-linux/run-probe.mjs "$TMPDIR/sdk-final"
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$TMPDIR/rpc-final" docs/evidence/worker-reconnect-linux/review-fix/rpc
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$TMPDIR/sdk-final" docs/evidence/worker-reconnect-linux/review-fix/sdk
```

Both summaries report **`supported`, all 11 checks true**. The deliberately
conflicting ambient selector still yields actual RPC for the RPC entry; SDK
explicitly imports `?runtime=sdk`. Full exact argv, neutral cwd, session IDs,
YAML, versions, channels and socket peer identities are retained under each
runtime directory. RPC uses the pinned `bundle/rpc-entry.js`; SDK uses actual
`packages/host/dist/sdk-worker.js`, not a shim. Both use pinned Pi **1.6.0**,
Node **v22.23.2**, npm **10.9.8**, Linux x64 kernel **7.2.15-1-omarchy**, and
credential-free `probe/busy` plus the original `probe_hold` fixture.

### RPC, 2026-11-26 02:25 UTC

[Summary](worker-reconnect-linux/review-fix/rpc/summary.json),
[daemon log](worker-reconnect-linux/review-fix/rpc/daemon.log),
[host log](worker-reconnect-linux/review-fix/rpc/host.log),
[YAML](worker-reconnect-linux/review-fix/rpc/alpha.yaml),
[cleanup](worker-reconnect-linux/review-fix/rpc/group-cleanup.json).

- Original host PID **3074951**, ID `52ff0140-2f26-489c-ad25-55b94d1dfba7`,
  survives unchanged.
- `hold/1`: original launch `5002552b-7310-4eae-a69f-215be9805627`, PID/PGID **3074972**.
- `hold/2`: original launch `ada4d8b7-7ae2-47fe-a502-ea8b96280302`, PID/PGID **3074978**.
- Daemon **3074936** SIGKILL at `02:25:14.209Z`; busy workers/host survive;
  old daemon sockets disappear, host sockets remain.
- New daemon **3075251** serves at `02:25:16.550Z`; originals authenticate at
  `02:25:17.970Z` / `02:25:17.972Z`. Each sends **2 heartbeats** by
  `02:25:27.979Z`; observation **12,012 ms**.
- Same two original live launches, slot bindings, busy hold records and host;
  **zero replacement launches**, no holds, sockets to the new daemon.

### SDK, 2026-11-26 02:25–02:26 UTC

[Summary](worker-reconnect-linux/review-fix/sdk/summary.json),
[daemon log](worker-reconnect-linux/review-fix/sdk/daemon.log),
[host log](worker-reconnect-linux/review-fix/sdk/host.log),
[YAML](worker-reconnect-linux/review-fix/sdk/alpha.yaml),
[cleanup](worker-reconnect-linux/review-fix/sdk/group-cleanup.json).

- Original host PID **3076709**, ID `206726df-8350-4137-a2e3-6305e5255fce`,
  survives unchanged.
- `hold/1`: original launch `9c0196ad-ac15-4cf8-86a1-a3167766ace9`, PID/PGID **3076720**.
- `hold/2`: original launch `d0483386-6cec-4b56-8a6a-82ecf34c0541`, PID/PGID **3076726**.
- Daemon **3076694** SIGKILL at `02:25:58.480Z`; same positive survival/socket controls.
- New daemon **3076898** serves at `02:26:00.777Z`; originals authenticate at
  `02:26:02.242Z` / `02:26:02.240Z`. Each sends **2 heartbeats** by
  `02:26:12.248Z`; observation **12,013 ms**.
- Same positive inventory, slot, busy-record and channel controls; **zero replacements**.

Both normal shutdown commands and daemon exits are **0**, hosts stop, no marked
processes remain before the owned sweep. No force sweep was necessary. Independent
signal-0 observations return **ESRCH** for all four original worker PGIDs; both
owned fixture roots are absent. Only owned scratch is eligible for cleanup after
marker/UID/mode/live-user verification; no reviewer scratch or unrelated cache.
Normalization uses the unchanged script and `<repo>`, `<node>`, `<fixture-root>`,
`<fixture-root>/validation-temp` provenance labels; IDs/times/argv/frame counts
are not changed.

## Final normal validation and remaining gates

All commands use the home-backed TMPDIR, **FOUNDRY_PI_BIN unset**, and **no shim**:

| Check | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| Direct `./node_modules/.bin/oxlint` | exit 0, no diagnostics |
| Focused suites | **15 tests / 3 files passed** |
| Full `npm test` | **862 tests / 105 files passed** |
| Separate `npm run test:e2e` | **5 tests / 3 files passed** |
| `git diff --check` | exit 0 |

[Machine-readable validation](worker-reconnect-linux/review-fix/checks/validation.json).
No assertion weakened, timeout widened, normal test skipped, paid model, real
credential, 1Password, production/operator-state access or global setting change.
The reviewer-confirmed P1 is addressed; fresh independent re-review is pending.
No PR, watch, merge, tracker closure or coordinator CURRENT.md update.

FOU-83/149/124 stay open. These fresh candidate probes do not replace their
post-merge acceptance or FOU-124's stronger successful-continuation/no-lost-work/
no-duplicate-committed-effects journey. No Mac support claim. The earlier
historical failed probe reports and original candidate artifacts are unchanged.
