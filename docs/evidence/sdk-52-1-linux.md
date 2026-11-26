# SDK Linux survival and reconnect — FOU-149 (draft 56f)

## Verdict: blocked on the tested implementation

The actual SDK Worker Host and pinned Pi were available. Both busy workers survived
an abrupt daemon-only kill, retained their original launch IDs and slots, and had
no replacements. **Neither reconnected or resumed channel traffic.** The passing
criterion is **unmet**; this negative record cannot close it or qualify the SDK.
This is not a claim that the SDK platform inherently cannot reconnect.

Contract: PRD §17.2 gate 1 and SDK fallback. No §17.3, restoration, compaction,
resource-isolation or explicit-stop gate qualification is claimed. Read alongside
[RPC sibling evidence](rpc-52-1-linux.md), [launcher decision](rpc-gate-decision.md)
and [SDK adapter trial](sdk-147-trial.md).

## Reproduce and inspect

```sh
npm ci
npm run build
node docs/evidence/sdk-52-1-linux/run-probe.mjs /tmp/fou149-evidence
```

The minimal SDK entry explicitly sets `FOUNDRY_WORKER_RUNTIME=sdk` and imports the
existing RPC sibling driver. The driver reuses the same actual daemon/host wiring,
45-second observation window and `probe-extension.ts`; it does not duplicate
product logic or replace an executable. Its small changes allow explicit runtime
selection (default remains RPC), disable fixture Git hooks, check preconditions
and daemon ownership before killing, record cleanup, and classify observation
exceptions as inconclusive rather than as product failures. This updates the older
sibling document's error-label description: driver errors are now inconclusive.
No automated test was added: only real process wiring can demonstrate survival.
The manual driver's exit 0 means it completed; inspect `summary.json.result`, not
its process exit, to decide the gate outcome.

Retained sanitized, credential-free outputs under [sdk-52-1-linux/artifacts/](sdk-52-1-linux/artifacts/):

- `summary.json`: versions, exact worker executable/argv/cwd, host identities,
  slots, inventory, timestamps, socket peers, channel counts and all checks.
- `alpha.yaml`: exact effective factory (including disposable absolute paths).
- `daemon.log`, `host.log`: complete real-process logs, including accepted
  initial channels, both restored original slots and shutdown.
- `group-cleanup.json`: independent post-run signal-0 check of both owned worker
  process groups (`ESRCH`) and confirmation that the disposable fixture was removed.

Only generated fixture data and local paths occur in these artifacts; no operator
configuration, secrets, credentials, production resources, 1Password, or paid
model were used. `.log` artifacts must be force-added if ignored by local rules.

## Exact tested versions, launcher and fixture

Executed 2026-11-26, Foundry `050145655c76a722afc6bce70ae422397e49872c`
(the merged SDK adapter base), with evidence-only uncommitted changes listed in
`summary.json`. Node `v22.23.2`, npm `10.9.8`, pinned repository Pi `1.6.0`,
Linux x64 kernel `7.2.15-1-omarchy`.

The driver launched the built daemon twice with:

```sh
<node> <repo>/packages/daemon/dist/main.js \
  --home /tmp/fou83-jhRxp4/home --log-level debug /tmp/fou83-jhRxp4/alpha.yaml
```

`<node>` was `/home/mark/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node`.
`<repo>` was `/home/mark/worktress/develop/t3-d84b1553-64f16b707698faba`.
The real detached host launched worker 1 as follows (worker 2's complete argv is
also retained; its session ID is `8dd572c6-617a-4b39-b588-31bf6b6d59c8`):

```sh
<node> <repo>/packages/host/dist/sdk-worker.js \
  --mode rpc --system-prompt '' --append-system-prompt '' \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve \
  --session-id 90292c18-be04-4356-9a87-5cd3a0c41c5d --model probe/busy \
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold \
  --extension <repo>/packages/extension/dist/index.js \
  --extension <repo>/docs/evidence/rpc-52-1-linux/probe-extension.ts
# cwd: /tmp/fou83-jhRxp4/home/slots/alpha/hold-1
```

`--mode rpc` is the host's compatible argument format, **not** the RPC runtime:
`sdk-worker.js` parses the arguments and calls the actual SDK session adapter,
with no stdin RPC command server. `FOUNDRY_PI_BIN` was absent.

Only PATH and an explicit allowlist reach the fixture. HOME, all XDG directories,
PI_CODING_AGENT_DIR, source repo, state, worktrees, sessions and probe markers
live under fresh `/tmp/fou83-jhRxp4`, subsequently removed. Global Git config is
`/dev/null`, system Git config disabled, fixture commits disable hooks, and
telemetry/offline settings are explicit. No real `~/.pi` or global config changes.

The factory `alpha` has two `eng.hold` instances (`hold/1`, `hold/2`), neutral
slot cwd, worktree isolation, explicit `probe/busy` credential-free faux provider,
and only the configured sibling extension naming `probe_hold`. No skill or
ambient provider is needed. The faux model really calls that tool; its execute
body records the launch and blocks until abort, keeping both workers busy during
the entire kill/restart window. The control records remained unchanged afterward.

## Observations and controls

| Observation | Verified result |
|---|---|
| Positive observation control | Each original launch had one accepted channel, one receipt and one heartbeat before kill; both actual model/tool runs reached `probe_hold`. |
| Original `hold/1` | `11cf6e2e-8fd5-4cd0-aa8b-6b2f826b9f00`, PID/PGID `2394387` |
| Original `hold/2` | `76ee3a41-6059-438c-bc6d-071dedc8b52b`, PID/PGID `2394388` |
| Daemon-only abrupt kill | PID `2394358`, SIGKILL at `00:46:09.947Z`; observed exit signal SIGKILL. |
| Survival | Both original worker PIDs and host `2394375` alive after kill and at end of restart observation. Same host ID `5f21a826-e226-467d-bd60-86151b821370`. |
| Negative connection control | Immediately after kill, both workers' original daemon sockets vanished; their three host sockets each remained. Confirms `ss` distinguishes host from daemon traffic. |
| Restart | New daemon `2394808` served at `00:46:12.217Z` on the same state root. |
| Same launches/slots, no replacement | After 45,044 ms, inventory contained exactly the two original live launches with original PIDs; slots retained original IDs, normal and no end recorded; hold list empty; busy-tool records unchanged. |
| Reconnect | **Failed:** zero accepted/refused channels for either original launch after restart. Neither worker acquired a socket to the new daemon. |
| Resumed traffic | **Failed:** zero frames or heartbeats for both original launches after restart. |
| Cleanup | Disposable-state `foundry shutdown` exit 0; host stopped, daemon exit 0, no marked process remained; both original PGIDs subsequently absent. |

Nine summary checks are true; `reconnectedToRestartedDaemon` and
`channelTrafficResumed` are false. The pre-kill accepted/heartbeat control and
post-kill socket loss control rule out an unavailable observer or platform.
No observation-tool error occurred. The first complete reproduction was retained;
no additional priming variants or product changes were tried to manufacture a pass.

## Diagnosis, independent remediation and limits

The shared Foundry extension still dials once at `session_start`.
`packages/extension/src/worker.ts` explicitly excludes a reconnect/backoff loop;
its `opened.channel.closed` callback only clears `channel`. The SDK adapter uses
this same extension and does not add redial. The observed absence of reconnect is
consistent with the prior RPC sibling failure, not an SDK incapability finding.

Separate remediation should implement bounded worker-side redial/reconciliation
for the same launch and conversation after channel loss, then rerun this gate.
The normal-looking stranded slots may separately need operator-visible reachability
state. Neither remedy belongs in this evidence-only task. A longer timeout alone
cannot supply the missing dial path.

Linux only, one real-process run with deterministic source corroboration. No
worker-exit restoration, execution replay, real model, macOS, automatic/mid-run
compaction, fresh/recovery priming, or complete shutdown-gate coverage was tested.
No fixture child was spawned, so cleanup proves these owned worker groups only,
not child escalation. All direct kill operations are restricted to the marked
run; the final fallback sweep found nothing to kill. The group absence checks
signal 0 only and never terminate unrelated groups.

## Repository health and handoff

Regression results are recorded separately below after rebasing to latest develop.
A fresh independent review remains required. No PR, merge, tracker mutation or
product-code fix was made; passing acceptance remains open.
