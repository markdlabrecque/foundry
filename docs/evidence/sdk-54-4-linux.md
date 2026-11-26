# Evidence: SDK explicit stop on Linux

Ticket: FOU-155, draft 56l. Contract: PRD §17.2 item 3; §17.3 adds no
explicit-stop requirement. This is manual real-process wiring evidence, not a
commit-tier timing test. No product code changed.

## Outcome and raw-probe discrepancy

**Supported on the tested Linux implementation for the listed explicit-stop
observations.** All three owned groups departed, only the named factory departed
before shutdown, and its neighbor survived until whole-instance shutdown.
Qualification of the SDK launcher as a whole remains open: this does not qualify
macOS, reconnect, isolation, restoration or priming.

**Important: the reused RPC harness reports `result: "failed"`, with 11 of 13
checks true.** The two false checks are `alphaChildOutlivedLeader` and
`betaChildOutlivedLeader`. They ask whether a child survives *after its leader
exits*, a behavior observed with RPC's exiting signal handler, not a requirement
of PRD §17.2 item 3. In this SDK run the leaders also remained alive until group
SIGKILL. The non-detached children were present throughout the sampled membership
intervals, escalation was reported, and all groups disappeared within the bound.
The raw result is retained unchanged, not relabeled as an all-green harness run.
This is a probe-expectation mismatch, not an observed failure to stop a group or
an unavailable platform. The follow-up adds a separate `sdk-assessment.json` with
eight independent contract checks, without rewriting any generic raw flag. A reviewer should assess the contract observations below
separately from those two stronger RPC expectations. The initial run stopped after complete observations. One bounded follow-up run
was explicitly requested to exercise the new SDK assessment; its raw flags again
remain 11/13, never 13/13.

| Criterion | Verification |
|---|---|
| Scoped departure with active work | **Verified.** Three workers entered the faux provider's `probe_hold` tool before stop. Non-force `factory stop alpha` returned exactly alpha's two launch IDs, both `drained: false, escalated: true`, exit 0 in 10,310 ms. Both alpha groups and child PIDs were absent afterwards. |
| Neighbor alive before shutdown | **Verified.** The same beta leader PID/PGID 2393635 and child 2393749 remained live after alpha stopped. Host inventory retained its original launch; factory list showed alpha stopped and beta running. This is the negative/scoping control. |
| Bounded escalation with non-detached child | **Verified.** Initial membership placed each child in its leader's PGID, matching fixture `detached: false`. The sampler polls every 250 ms and retains changed membership only: alpha's six-process initial membership became beta-only at +10,299 ms; beta's pair became empty at +10,341 ms during shutdown. No intermediate membership change was recorded. Every stop result reports escalation; host logs record SIGKILL for all three leaders. Child-after-leader-exit is **not observed** and is not claimed. |
| No owned groups after whole-instance shutdown | **Verified.** Non-force shutdown exited 0 in 10,341 ms with `hostStopped: true`. `ps` found no member in any of the three recorded groups; signal-0 probes found every group and child absent. Daemon exited 0, host absent, run-marker process scan empty **before** fallback cleanup. |

No required Linux explicit-stop criterion is unmet or unverified. The table
records the initial run; independent review and the follow-up run are detailed
below. Regression-suite success is not the evidence for these process observations.

## Follow-up assessment and validation (current retained run)

Independent GPT 6.1 SOL review of `090920a` was supplied by the coordinating
thread: no narrow evidence-approval blockers, independently reproduced SDK 11/13
with the same two RPC-specific diagnostic failures, and backward-compatible RPC
13/13. These are attributed review observations, not new runs performed here.
The reviewer also reported repeat interrupt e2e timeouts, requiring follow-up.

The current repeat run, 2026-11-26 01:02:23–01:02:46 UTC, used the same product
base and versions as the initial run, with the SDK assessment and harness-only
changes visible in the raw `versions.uncommitted` record. It records:

- Alpha PGIDs 2616382 / 2616389 with non-detached children 2616598 / 2616615.
  Scoped stop completed in **10,306 ms**, escalated both, leaving neither group.
- Original beta launch `6786f5e8-b300-4b34-a58e-550310a9ea8a`, PID/PGID 2616395,
  child 2616609, survived alpha stop. The retained post-stop inventory now includes
  launch ID and PID, explicitly compared with the original identity.
- Beta shutdown completed in **10,298 ms**, with escalation of that exact launch.
  Every owned group/child, host and daemon was absent before fallback cleanup.
- `sdk-assessment.json`: **supported**, eight contract checks true. Each CLI
  duration must be positive and at most **17,000 ms**: the documented 5+5+5 s
  stop windows plus 2 s CLI overhead. Unexpected extra stop/shutdown launches,
  replaced beta identities, missing fixture children or cleanup-only absence
  cannot produce a supported assessment.
- `summary.json`: original generic **failed**, **11/13** flags true, with both
  child-outlives-leader flags still false. The shared RPC verdict is unchanged.

Current artifacts are at `sdk-54-4-linux/`; the initial run's exact summary,
YAML and daemon/host logs are preserved under `initial-run/`. The detailed
initial-run timeline/launcher below refer to those initial artifacts; the current
run's full launcher is in the current `summary.json`.

### Short disk-backed reproduction

```sh
npm ci && npm run build
short=$(mktemp -d "$HOME/f155-XXXXXX")
TMPDIR="$short" node docs/evidence/sdk-54-4-linux/run-probe.mjs "$(mktemp -d "$HOME/f155-out-XXXXXX")"
rmdir "$short"
# Full checks, with the child-Pi TMPDIR workaround (output remains for inspection):
bash docs/evidence/sdk-54-4-linux/run-validation.sh docs/evidence/sdk-54-4-linux/checks/reproduction
```

The probe now passes its disposable run root as `TMPDIR` to its isolated children,
keeping Pi's transpiler cache out of global `/tmp`. This is manual harness
isolation, not a product/testkit change. Use a short disk-backed root: checkout-
length roots can exceed Unix-socket path limits.

### Interrupt environment control and final checks

`startFauxPi` deliberately drops outer environment variables except PATH; an outer
TMPDIR alone therefore does not control its Pi child's transpiler cache. No change
was made to that shared testkit. The retained `run-validation.sh` generates a
private temporary executable shim, exporting a short home-backed TMPDIR *inside*
the Pi child before exec of this checkout's unchanged pinned Pi `dist/cli.js`.
The helper captures its exact shim/environment, runs the exact interrupt test,
full ordinary Vitest and ordinary e2e suite, then removes only its own temp root.
It never deletes `/tmp/jiti`, global caches or unrelated temporary files.

Reviewer timeout logs are copied to `checks/followup/reviewer-*-timeout.log`.
The independent FOU-124 diagnostic's explicit ENOSPC attribution was supplied by
the coordinator, not generated here. This follow-up's `tmp-inode-control.log`
records a fresh uniquely named `/tmp` write failing with **ENOSPC**, with
**0 free inodes** of 1,048,576. The controlled
outer-TMPDIR/no-shim interrupt run **passed 1/1** (`interrupt-before.log`); it did
not reproduce the reviewer's timeout, likely benefiting from existing cache
entries. That possibility is not a measured cache-hit claim. Consequently this
is **not** claimed as a deterministic red-to-green product fix.

With the private child shim, the exact interrupt test passed **1/1**; full suite
passed **100 files / 837 tests**; complete ordinary e2e passed **3 files / 5
tests**. Build, typecheck and direct oxlint all exited 0. Exact commands, child
shim, environment and exit codes are retained in `checks/followup/`. After
committing, fetching and rebasing latest `origin/develop` (unchanged product base
`050145655c76a722afc6bce70ae422397e49872c`), the entire helper was repeated:
build/typecheck/direct lint exit 0, exact interrupt **1/1**, full Vitest **100
files / 837 tests**, ordinary e2e **3 files / 5 tests**, all exit 0. Final command
outputs, effective shim, environment and exits are in `checks/final/`. This resolves
the requested final controlled validation without claiming the earlier timeout
could not recur under the exhausted uncontrolled `/tmp` environment.

Retained text logs are normalized only by removing trailing whitespace on each
line and trailing blank lines, retaining one final newline for nonempty files.
JSON/YAML observations are not normalized. `checks/normalization.txt` lists the
normalized log paths; content, diagnostics, counts and exit codes are not changed.

## Initial-run versions, revision and exact launch

Run: 2026-11-26 00:45:44–00:46:07 UTC. Linux x64, kernel `7.2.15-1-omarchy`,
Node `v22.23.2`, npm `10.9.8`, pinned Pi `1.6.0`. Product revision:
`050145655c76a722afc6bce70ae422397e49872c` (SDK adapter merged). The raw `versions`
record correctly identifies uncommitted evidence/harness changes; product files
were clean. `npm ci` and build completed before the probe.

Reproduce at repo root after `npm ci && npm run build`:

```sh
short=$(mktemp -d "$HOME/f155-XXXXXX")
TMPDIR="$short" node docs/evidence/sdk-54-4-linux/run-probe.mjs "$(mktemp -d "$HOME/f155-out-XXXXXX")"
rmdir "$short"
```

The SDK wrapper reuses `../rpc-54-4-linux/run-probe.mjs` and its existing
`probe-extension.ts`; the shared driver gains an optional validated runtime
argument, records that selector and post-stop launch identities, and isolates
child TMPDIR. Its existing raw predicates/verdict are unchanged. The wrapper supplies `sdk`, which sets
**`FOUNDRY_WORKER_RUNTIME=sdk`** in the isolated daemon environment. No
`FOUNDRY_PI_BIN` override is provided. The daemon starts the real detached Worker
Host, which launches real SDK workers with the pinned Pi dependency. Driver:

```text
<node> <repo>/packages/daemon/dist/main.js
  --home /tmp/fou122-EL6FrC/home
  /tmp/fou122-EL6FrC/alpha.yaml /tmp/fou122-EL6FrC/beta.yaml
```

Alpha hold/1's actual worker command, recorded by the fixture inside the process:

```text
/home/mark/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node
  <repo>/packages/host/dist/sdk-worker.js
  --mode rpc
  --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id c00f8bfd-a7df-4a40-9b9c-832d7f31964c
  --model probe/busy
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_hold
  --extension <repo>/packages/extension/dist/index.js
  --extension <repo>/docs/evidence/rpc-54-4-linux/probe-extension.ts
cwd: /tmp/fou122-EL6FrC/home/slots/alpha/hold-1
```

`<repo>` was `/home/mark/worktress/develop/t3-f172784f-648f1e4550390ef4`.
The full executable, argv, cwd and conversation ID of **all three** workers are
retained in `summary.json`. The inherited `--mode rpc` flag is the adapter's
RPC-compatible resource argv; the executable is `sdk-worker.js`, not the RPC
entrypoint, and it creates an SDK session with no stdin RPC server. Selection is
explicit, not inferred from that legacy argument.

CLI commands use `<node> <repo>/packages/cli/dist/main.js`, with
`--home /tmp/fou122-EL6FrC/home --json` appended:
`factory stop alpha`, `factory list`, then `shutdown`. No `--force` was used.

## Effective fixture and controls

[alpha.yaml](sdk-54-4-linux/alpha.yaml) and
[beta.yaml](sdk-54-4-linux/beta.yaml) are the exact YAML as run. Alpha has two
`eng.hold` instances, beta one. Each factory has a disposable local Git source on
`main`, its own worktree root, `isolation: worktree`, explicit model `probe/busy`
and the shared probe extension with the only named tool `probe_hold`. The final
Tool Set is twelve fixed tools plus that named tool. Three accepted Foundry
channels (13 tools each) are recorded in the daemon log.

The faux provider is credential-free and runs offline. `session_start` schedules
`sendUserMessage("hold")`; its model response calls `probe_hold`, which spawns
`node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);"`
with `detached: false`, writes the worker/child/launch identities, and holds its
tool promise until abort. The tool never kills the child. This is the positive
escalation control. The independent beta factory is the negative stop-scope
control; this is not an empty-set pass.

The environment is an explicit allowlist: inherited PATH only, plus temporary
HOME and XDG config/data/cache under `/tmp/fou122-EL6FrC/user`,
`PI_CODING_AGENT_DIR=/tmp/fou122-EL6FrC/agent`, `PI_OFFLINE=1`,
`PI_TELEMETRY=0`, SDK selector, an intentionally different `FOUNDRY_HOME`,
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_TERMINAL_PROMPT=0`, disposable author/committer identity and
`PROBE_DIR=/tmp/fou122-EL6FrC/probe`. Agent settings contain only
`enableInstallTelemetry: false`. State is selected through `--home`, not global
config. No real `~/.pi`, operator repositories, provider credentials, 1Password,
network models, production resources or global-control experiment were used.

## Owned identities, timeline and cleanup

| Factory/slot | Launch ID | Leader / PGID | Child |
|---|---|---:|---:|
| alpha hold/1 | 55b356c9-bbbc-4ad2-b756-9fd4ef87bbf6 | 2393627 | 2393743 |
| alpha hold/2 | 3bf93098-b6fa-4d4d-9638-9e074ac435c7 | 2393629 | 2393737 |
| beta hold/1 | 18f02b05-29e4-4412-8e60-7eab32e16fd0 | 2393635 | 2393749 |

Daemon 2393594; Worker Host 2393616. All children initially had their worker as
parent and the same PGID as the worker. Stop started 00:45:47.039 UTC; alpha
channels closed 00:45:52.299; alpha leaders ended with SIGKILL at 00:45:57.303.
Beta remained alive. Shutdown started 00:45:57.629; beta channel closed
00:46:02.932; beta leader ended with SIGKILL at 00:46:07.933. Host accepted
shutdown at 00:46:07.951. Process absence was recorded at 00:46:07.986.

Defaults allow 5 s to drain, then 5 s after group SIGTERM before SIGKILL, then up
to 5 s to confirm departure. The observed ~10.3 s CLI durations are consistent
with the two grace windows and bounded departure. Signal *send* instants are
inferred from `factory-stop.ts`/`terminate.ts`, not directly traced. The host's
SIGKILL exit records and CLI `escalated: true` are observed. SDK's signal handler
aborts/disposes the session but does not call process.exit; the fixture child
handle can therefore keep its leader alive. That difference explains the two
RPC child-outlives-leader expectation failures, without weakening the requirement
for non-detached child escalation or absence of the whole group.

The driver discovers fallback-cleanup targets by exact unique `PROBE_DIR` marker
in `/proc/<pid>/environ`, rechecking immediately before each individual SIGKILL.
It never sends a destructive signal to a recorded group itself: group termination
is done by the actual host. In this run no marked process remained before the
fallback sweep, so fallback cleanup did not manufacture the shutdown evidence.
The temporary root was removed. No unowned group was signaled by the driver.

## Retained artifacts and limits

Under [sdk-54-4-linux/](sdk-54-4-linux/):

- `run-probe.mjs`: minimal SDK driver, using the existing sibling fixture/harness.
- `summary.json`: original raw checks, versions, exact worker launchers, inventories,
  command responses, timings, changed-membership samples and final absence checks.
- `alpha.yaml`, `beta.yaml`: effective fixture.
- `daemon.log`, `host.log`: disposable run logs only; no credentials or operator
  content. Absolute local source/temp paths and random run identifiers are retained
  for reproducibility, not secrets.
- `checks/`: captured regression command output and exit summary.

One initial run and one requested bounded follow-up; no daemon kill, restart, graceful drain acknowledgement,
force stop, detached descendants, inaccessible/foreign groups, real providers or
other platform were tested. The known shared-extension reconnect problem was not
changed, disproved or qualified. Prior context:
[rpc-54-4-linux.md](rpc-54-4-linux.md),
[rpc-54-4-macos.md](rpc-54-4-macos.md) (not a Linux replacement),
[rpc-gate-decision.md](rpc-gate-decision.md), and
[sdk-147-trial.md](sdk-147-trial.md).

The follow-up implements the separate SDK contract assessment, retaining
child-outlives-leader in the unchanged generic aggregate as a diagnostic. No product remediation is proposed to make those RPC-only
predicates pass. Any SDK child-handle/graceful-exit improvement is separate work,
not a prerequisite invented by this evidence and not implemented here.

## Initial regression verification and handoff

Against product base `050145655c76a722afc6bce70ae422397e49872c`:
`npm run build`, `npm run typecheck`, direct `./node_modules/.bin/oxlint`,
full direct `./node_modules/.bin/vitest run`, and separate direct
`./node_modules/.bin/vitest run --config vitest.e2e.config.ts` all exited 0.
Vitest: **100 files / 837 tests passed**; separate e2e: **3 files / 5 tests passed**.
The direct oxlint log is intentionally empty (zero diagnostics), with exit 0
recorded separately. These checks do not turn the raw manual probe aggregate
into a passing automated test.

After committing, fetching and rebasing (already up to date at the same product
base), build/typecheck/direct oxlint again exited 0. The first post-rebase suite
attempts hit `/tmp` inode exhaustion: `df -i /tmp` showed 1,048,517 used of
1,048,576 inodes, 59 free, despite 22 GiB free space. Git fixture creation emitted
`No space left on device`; full suite exit 1 (77 files passed / 23 failed,
690 tests passed / 147 failed), e2e exit 1 (2 passed / 3 failed tests).
No unrelated temporary files were deleted. A checkout-local TMPDIR avoided inode
exhaustion but introduced long Unix-socket-path errors (ENOENT/EADDRINUSE): full
suite exit 1 (59 files passed / 41 failed, 696 tests passed / 141 failed), e2e
exit 1 (1 passed / 4 failed tests). Both attempts' full logs are retained as
`checks/*-tmpfs-inode-failure.log` and `checks/*-long-path-failure.log`.

The initial handoff's final post-rebase verification used the short disposable
`TMPDIR=/home/mark/f155-SUvrBu` for both direct Vitest commands: **exit 0,
100 files / 837 tests**, and **exit 0, 3 files / 5 e2e tests**. Those final passing
outputs are `checks/vitest.log` and `checks/e2e.log`. Only TMPDIR changed; no test
or product fix was applied. Both agent-owned regression temp roots were removed
after their tests cleaned up, including residual jiti caches. These regression
environment failures occurred after the manual SDK observations and do not alter
that raw probe result or establish a product regression.

Branch: `marklabrecque/fou-155-check-sdk-explicit-stop-on-linux`. No merge,
tracker edit or product fix. Fresh independent review supplied by the coordinator
supports the narrow Linux contract verdict and the raw diagnostic reconciliation.
The assessment/validation follow-up is explicitly documented above; no overall
launcher qualification is implied.
