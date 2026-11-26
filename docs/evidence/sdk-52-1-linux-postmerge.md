# FOU-149: post-merge SDK survival and reconnect acceptance on Linux

## Result and scope

**Supported on the tested implementation.** On 2026-11-26, the unchanged actual-SDK
survival probe passed **all 11 checks** after merged reconnect remediation
[PR #144](https://github.com/markdlabrecque/foundry/pull/144), commit
`477b169f2b23a1a952008b2f5d7a5b28d02324bb`.

The original [FOU-149](https://linear.app/foundry-mdl/issue/FOU-149/check-sdk-survival-and-reconnect-on-linux)
Linux criterion is positively observed: two original busy workers survive abrupt
daemon-only SIGKILL, reconnect with accepted original launch identities, resume
channel traffic, and retain their original slots with no replacement.
This record awaits fresh independent review; no issue status change is made.

This is Linux gate-1 acceptance under PRD §17.2, **not** macOS, complete SDK launcher
qualification, worker-exit restoration, real-model behavior, explicit-stop escalation,
§17.3, or the combined assigned-work/crash proof. Separate owners retain RPC
acceptance and the combined proof. No runtime is declared inherently incapable.

The [historic failed investigation](sdk-52-1-linux.md) and all of its artifacts are
preserved unchanged. That pre-remediation result was valid on its tested revision;
these new post-merge artifacts do not relabel it as a pass.

## Recovery basis and reproducibility

The full live issue and comments (none), dependency relations, PRD §17.2–3 and
current merged source were read before this acceptance run. The issue remains
In Progress pending reviewed positive acceptance; merged failure evidence and
implementation alone were not acceptance. A new branch was created directly from
fetched `origin/develop`, not from the old merged evidence branch.

Tested merged commit: **`089ab52ac2deeeac53c59e8597605bcad309127a`**
(the subsequent collision acceptance [PR #145](https://github.com/markdlabrecque/foundry/pull/145)
is included). Probe-time `versions.uncommitted` is empty.

```sh
umask 077
scratch=$(mktemp -d "$HOME/.f149p-XXXX")
export TMPDIR="$scratch"
unset FOUNDRY_PI_BIN
npm ci
npm run build
node docs/evidence/sdk-52-1-linux/run-probe.mjs "$scratch/sdk-probe"
npm run typecheck
./node_modules/.bin/oxlint
npm test
npm run test:e2e
# Independently inspect only the recorded owned worker PGIDs with signal 0,
# check marker absence/root removal, then retain group-cleanup.json.
python3 docs/evidence/sdk-52-1-linux/normalize-artifacts.py "$scratch/sdk-probe" /path/to/new-artifacts
git diff --check
# After retaining outputs and verifying no owned processes: remove only scratch.
```

The exact existing SDK wrapper, shared manual driver and faux-provider fixture are
reused **without changes or weaker assertions**. No new testkit/test/product code,
shim, `FOUNDRY_PI_BIN` override or timing-dependent commit-tier test is introduced.
The manual probe watches up to 45 seconds but exits observation once both original
accepted channels have sent at least two heartbeats; this run reached that condition
in **12,010 ms**. Its exit 0 indicates completion; `summary.result: supported` and
all required checks, not exit status alone, establish the outcome.

## Versions, fixture and exact launcher

- Node **v22.23.2**, npm **10.9.8**, pinned lockfile Pi **1.6.0**.
- Linux x64, kernel **7.2.15-1-omarchy**.
- Runtime explicitly selected by the SDK wrapper: **FOUNDRY_WORKER_RUNTIME=sdk**.
- Fresh private disposable state and fresh **host control protocol 5** implementation.
  No existing operator host was contacted or upgraded. The built host client rejects
  an incompatible `identify.controlVersion`; both successful inventory/identify
  sequences used this fresh host. Channel wire protocol is separately version 1.
- Faux provider **probe/busy**, offline and credential-free. Both workers execute
  `probe_hold` and remain inside its blocked actual tool call throughout observation.
- One disposable `alpha` factory, `eng.hold` with two instances, explicit configured
  sibling extension naming only `probe_hold`, neutral slot cwd and worktree isolation.
  Full effective YAML is retained. No global fixture control is needed for gate 1.

The allowlisted child environment explicitly supplies isolated HOME, XDG directories,
PI_CODING_AGENT_DIR, TMPDIR, offline/telemetry settings, Git isolation and the unique
process marker. Child `TMPDIR=<fixture-root>/tmp` stays on the short home-backed
filesystem. The disposable source Git commit disables hooks. No credentials, paid
models, 1Password, production resources, operator state or global config/cache
modification is involved.

Exact normalized daemon argv (both starts):

```sh
<node> <repo>/packages/daemon/dist/main.js --home <fixture-root>/home --log-level debug <fixture-root>/alpha.yaml
```

Worker 1's exact ordered normalized argv:

```sh
<node> <repo>/packages/host/dist/sdk-worker.js \
  --mode rpc --system-prompt '' --append-system-prompt '' \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve \
  --session-id f9a505a9-242b-4a80-98f7-24ceb0eddf59 \
  --model probe/busy \
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold \
  --extension <repo>/packages/extension/dist/index.js \
  --extension <repo>/docs/evidence/rpc-52-1-linux/probe-extension.ts
# cwd: <fixture-root>/home/slots/alpha/hold-1
```

Worker 2 has the same ordered flags with session ID
`8224ad2d-3384-47cf-86dc-f02cfa5042d2` and cwd ending `hold-2`. Both complete
commands are retained in `provenance.json` and the tool witnesses in `summary.json`.
`--mode rpc` is compatible host argument syntax, **not** RPC runtime: the actual
executable is `sdk-worker.js` and it creates the pinned SDK session.

## Observations and per-criterion results

| Required observation | Verified evidence |
|---|---|
| Two busy workers in distinct slots | Both actual `probe_hold` witnesses present at `02:40:07.765Z` / `.774Z`; two distinct slots, initial accepted channels, receipt and heartbeat each. |
| Original `hold/1` | Launch `39d1a541-0532-48a3-ae76-5e4a023564ac`, PID/PGID **3141427**. |
| Original `hold/2` | Launch `16b39346-058c-4a6f-b2fd-e99e506e7cd8`, PID/PGID **3141433**. |
| Abrupt daemon-only kill | Daemon **3141396** receives SIGKILL at `02:40:14.156Z`; observed exit signal SIGKILL. |
| Survival | Both original PIDs and host **3141410** remain alive after kill and restart. Same host ID `890bfd1b-7296-4a5c-9b05-4909253af284`. |
| Negative connection control | Original daemon sockets vanish after kill; four host sockets per worker remain. |
| Restart | New daemon **3141934** serves at `02:40:16.456Z` on same disposable state. |
| Authenticated reconnect | Original `hold/2` accepted at `02:40:17.916Z`, original `hold/1` at `.918Z`. Production slot claim validates host-known launch identity before acceptance; no refusal. |
| Resumed traffic | Each original accepted channel sends **two heartbeats**; last at `02:40:27.922Z` / `.924Z`. New worker sockets peer with new daemon PID **3141934**. |
| Same launches/PIDs/slots, no replacements | Exactly the two original live inventory entries; original normal slots, no end recorded, no hold, no additional launch. Busy-tool records are unchanged, not new executions. |
| Cleanup | Shutdown exit 0; both launches exit 0, host stops, daemon exit 0; no marked process remains; both original PGIDs independently return `ESRCH`; fixture root absent. |

All 11 unchanged driver checks are true: `fixtureShape`, `connectedBeforeKill`,
`daemonKilledAbruptly`, `workersAndHostSurviveKill`, `sameHostAfterRestart`,
`workersStillAlive`, `sameLaunchesInSlots`, `noReplacement`,
`reconnectedToRestartedDaemon`, `channelTrafficResumed`, `shutdownLeavesNothing`.
No observation error or unsupported/unavailable platform condition occurred.

**Verified:** original positive Linux criterion, including reconnect and resumed traffic.
**Unmet:** none among this run's required observations.
**Unverified/outside scope:** fresh independent acceptance review, other platforms,
full launcher qualification and other acceptance journeys. This evidence does not
claim execution replay or new message/tool processing after reconnect: the required
resumed channel traffic here is authenticated heartbeats while original work stays busy.

## Retained artifacts, normalization and checks

New files only under [sdk-52-1-linux-postmerge/](sdk-52-1-linux-postmerge/):

- `artifacts/summary.json`: all checks, versions, original/post-restart identities,
  tool witnesses, argv, sockets, accepted channels and traffic counts.
- `artifacts/alpha.yaml`, `daemon.log`, `host.log`: complete effective fixture and
  real process logs.
- `artifacts/group-cleanup.json`: independent PGID signal-0 checks, marker absence
  and fixture-root removal, timestamped after shutdown.
- `artifacts/provenance.json`: exact full tested/merged commits, versions,
  ordered commands, and **SHA-256 source/build hashes** of the unchanged drivers,
  fixture, lockfile, host control/SDK adapter, worker reconnect lifecycle and daemon
  slot-claim authorization boundary.
- `checks/`: compact successful normal-command output; full counts/times retained.

Normalization uses the existing portable normalizer: lexical prefixes become
`<repo>`, `<node>`, `<fixture-root>` (validation output parent becomes
`<fixture-root>/validation-temp`). This does not alter relative resource paths,
argv order, IDs, timings, frame counts or error text. Node prefix denotes the
recorded Node version. These labels are not literal executable paths.

| Normal command, no wrapper | Exit / result |
|---|---|
| `npm ci` | 0, zero audit vulnerabilities |
| `npm run build` | 0 |
| `npm run typecheck` | 0 |
| Direct `./node_modules/.bin/oxlint` | 0, no diagnostics |
| `npm test` | 0, **862 tests / 105 files passed** |
| Separate `npm run test:e2e` | 0, **5 tests / 3 files passed** |
| `git diff --check` | 0 |

Regression health is separate from the real-process gate result. Cleanup never
signals unmarked groups or deletes unrelated temporary files/config/caches. The
manual driver's fallback sweep found nothing to kill. After retained output was
copied, only this run's owned validation scratch was removed.

## Handoff

Positive Linux observation is ready for **fresh independent review** before any
PR or acceptance status decision. This branch is evidence-only; no product/test
change, PR, watch, merge, Linear mutation or coordinator CURRENT edit is made.
