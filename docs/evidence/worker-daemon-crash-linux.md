# FOU-124 — combined worker/daemon crash journey (Linux)

Ticket: [FOU-124](https://linear.app/foundry-mdl/issue/FOU-124/prove-worker-and-daemon-crash-durability-together). Contract: PRD §18.1(4): killing a worker and restarting the daemon mid-run loses no accepted messages or tracked work.

**Blocked, not accepted.** The bounded real-Pi journey reproduced the known missing-reconnect boundary. The killed worker was replaced successfully. After the subsequent daemon-only SIGKILL, the two then-live workers and their host survived with unchanged launch identities, but neither worker reconnected or resumed channel traffic within 45 seconds. Persisted messages and ticket artifacts are not sufficient evidence of recovered execution. No tracker state, PR or production code was changed.

## Versions, base and effective fixture

Executed on 2026-11-26 UTC, Linux x64, kernel `7.2.15-1-omarchy`, Node `v22.23.2`, pinned Pi `1.6.0`, Foundry `40ea1faff294990789b3fd92119c10146bc8978a` (latest develop at initial fetch). The uncommitted additions were only this disposable probe/instrumentation. The final branch was rebased onto `050145655c76a722afc6bce70ae422397e49872c` before final validation. That intervening commit adds the explicitly selected SDK trial; RPC remains the default and the shared worker extension's dial behavior is unchanged. **The retained crash run is on 40ea1fa, not a claimed SDK or 0501456 crash run.** No second product-failure reproduction was run after the first reproducible failure.

- One disposable factory `alpha`, station `eng.dev`, two worktree-isolated instances, two assigned tickets in writing stage `a`; stage `b` is an operator approval gate. No ticket is released for completion or integration.
- Model `foundry-faux/scripted`, registered by the existing testkit faux provider, no paid provider, network model call or credentials.
- [Effective YAML](worker-daemon-crash-linux/run/factory.yaml) and [version/environment record](worker-daemon-crash-linux/run/result.json) preserve actual absolute paths (the temporary root has since been removed).
- The [observer extension](worker-daemon-crash-linux/worker.ts) wraps the existing `packages/daemon/e2e/fixtures/concurrent-worker.ts`, without replacing its work tool or the production channel. `fixture_work` writes ticket-number markers into its assigned worktree/evidence directory and holds until release/abort. The existing faux provider calls it inside real Pi.
- [Actual launchers and tool calls](worker-daemon-crash-linux/run/worker-events/worker.jsonl) record executable, argv, cwd, PID, launch ID and slot, including the replacement. Worker Host used Node's pinned Pi `dist/bundle/rpc-entry.js`, `--mode rpc`, an explicit conversation ID, explicit faux model, the production Foundry extension, faux provider and observer extension. Ambient extensions/MCP/skills/templates/themes/context files and approval prompts were disabled by the production launcher. Full fixed plus `fixture_work` tool list is retained in argv.
- Fresh `HOME`, XDG directories, `PI_CODING_AGENT_DIR`, Foundry home, Git source, Git identity and worktree root. The daemon/host/worker environment is an allowlist, not an operator environment copy. No production, 1Password, operator Foundry/Pi state or credential access.

## Reproduction and expected versus observed

After `npm ci && npm run build`, run explicitly (E2E tier, never a commit-suite test):

```sh
node docs/evidence/worker-daemon-crash-linux/run-probe.mjs /path/to/new-output-directory
```

Linux `/proc` is required for marker-scoped cleanup. Exit 1 means blocked/inconclusive; even a reconnect-only result is deliberately not described as full ticket acceptance. The probe stops at its first failure and does not implement redial, force a reconnect, restart workers to mask failure, or replay committed tools.

1. Submit two specs through the actual CLI. Wait for assigned tickets and both real Pi workers' held-work markers. Capture spec SHA-256, ticket directory/spec/evidence paths, worktree identity, branch and Git head.
2. Send `FOU124_ACCEPTED_BEFORE_WORKER_KILL` through `foundry message send eng.dev ... --delivery when_idle`. CLI succeeds with message `57bb67bc-584f-4010-a279-8218abf36764`, sequence 3, initially `unbound`. The pre-restart offline snapshot confirms it became bound to `dev/1` and acknowledged; the response alone is not treated as binding proof.
3. SIGKILL only original `dev/1` worker PID **2407859**, launch `8c43d38d-32ca-4621-88d5-1176e869ba07`. Expected: same logical slot/assignment/conversation and artifacts, new worker, appropriate recovery notice. Observed: replacement PID **2407985**, launch `cbf5bfb8-7839-4697-b974-836addbbcf57`, same conversation `05b477b1-b4d7-45b5-a228-a5c550c1807d`, accepted channel and another actual `fixture_work` call. Ticket 1's assignment remained `e65f34bd-6fdf-47b5-a978-5d02d337c519`, recovery count 1. Its warning not to blindly replay tools was persisted/acknowledged as sequence 4; `resumed.txt` is retained.
4. While both workers are again in active held work, SIGKILL only daemon PID **2407832** (actual exit `SIGKILL` is retained), copy its closed DB+WAL for read-only evidence, and restart on the same home. Expected: both live workers reconnect, preserve accepted work and resume channel recovery. **Observed failure:** during **45,308 ms**, restarted daemon PID **2408071** logged both slots running but **zero channel accepts and zero channel frames**. Host PID **2407848**, surviving `dev/2` PID **2407860**/launch `c091e9ba-d33d-42f7-9d89-366a0494ee81`, and replacement `dev/1` PID/launch remained unchanged and live. No replacements masked the missing reconnect.
5. Stop at that failure. Kill the evidence daemon and all processes carrying the unique `PROBE_DIR` marker, verify none remain, retain outputs, remove disposable root `/tmp/fou124-VikFuh`. No fixture process or temporary Git worktree remains active.

The evidence includes all 4 accepted message rows and both active assignments before/after daemon restart, plus full history/launch/slot/message-attempt rows. IDs, bodies and bindings survive; both worktree heads remain `77e3b55c7b4a36a450df55404345136ed9347ed6`, and the captured paths/spec hashes/started marker contents remain identical. Sequence 2 is still `sent`, not acknowledged; it must not be relabelled delivered/recovered. The ordinary operator message is already acknowledged before daemon restart, so this does not separately prove recovery of a pending operator message. Assignment-context delivery and continuation remain blocked.

## Acceptance accounting

| Requirement | Result | Evidence / limit |
|---|---|---|
| Disposable repo, real Pi faux workers, worker kill followed by daemon restart during active work | **Verified on Linux** | CLI transcript, actual launchers/tool calls, host inventory and daemon logs |
| Bound accepted work persists across the combined journey | **Verified persistence only** | 4 message rows with unchanged IDs/bodies/bindings; 2 assignments remain tracked |
| Ticket artifacts stay attached and unchanged | **Verified for captured fixture artifacts** | Paths, spec hashes, branch/worktree identities, Git heads and started markers; final copied specs/evidence |
| Appropriate recovery after worker death | **Verified for this held-work fixture** | Replacement channel, same conversation/assignment, acknowledged resume warning, recovery count 1, resumed marker |
| Appropriate recovery after daemon restart | **Unmet** | Both live workers fail to reconnect or send frames within 45 seconds |
| Real Pi E2E demonstrates durable accepted work with no lost tracked work and no duplicate committed effects | **Unmet overall; continuation/exactly-once effects unverified** | Records survive, execution does not recover. Fixture never commits a ticket implementation or transitions it complete; unchanged initial Git heads are **not** an exactly-once commit proof |
| Cross-platform launcher qualification / SDK recovery | **Unverified, out of this bounded Linux run** | No macOS or SDK crash run performed |

This is consistent with [FOU-83's independent failed gate](rpc-52-1-linux.md): `packages/extension/src/worker.ts` dials once without lost-channel redial. [FOU-94's same-launch connected-channel recovery](https://github.com/markdlabrecque/foundry/pull/135) does not reconnect the real extension. The [SDK trial](sdk-147-trial.md), merged while this work ran, also explicitly leaves shared extension redial unchanged. This ticket does not implement that shared recovery work or select a new launcher. FOU-124 must not be marked Done from these negative results.

## Artifacts and verification

- [Probe driver](worker-daemon-crash-linux/run-probe.mjs), [observer](worker-daemon-crash-linux/worker.ts).
- [Raw combined stdout/stderr](worker-daemon-crash-linux/run/stdout.log), [structured result/checks](worker-daemon-crash-linux/run/result.json), [daemon log](worker-daemon-crash-linux/run/logs/daemon.log), [host log](worker-daemon-crash-linux/run/logs/host.log), [worker launcher/tool journal](worker-daemon-crash-linux/run/worker-events/worker.jsonl).
- [Before restart rows](worker-daemon-crash-linux/run/before-restart/records.json), [after restart rows](worker-daemon-crash-linux/run/after-restart/records.json), copied specs/markers under `worker-daemon-crash-linux/run/tickets/`. SQLite snapshots were read only after daemon exit, on copies; raw DB/WAL copies were not committed. No live database was opened by the evidence reader.
- A preliminary instrumentation attempt incorrectly waited for a nonexistent `activity` channel frame after replacement acceptance. It timed out and was fully cleaned up. This was **not** a product failure/reconnect gate result; it was corrected to observe the real replacement Pi `fixture_work` call via a narrow observer. Its [original output](worker-daemon-crash-linux/preliminary/stdout.log) and [result](worker-daemon-crash-linux/preliminary/result.json) are retained rather than hidden.
- Final-base checks: build **exit 0**; typecheck **exit 0**; direct `./node_modules/.bin/oxlint` **exit 0**, empty diagnostics; full commit-tier Vitest **exit 0, 100 files / 837 tests passed**; separate E2E **exit 0, 3 files / 5 tests passed**. Full logs and explicit exit status manifest are under `worker-daemon-crash-linux/checks/`.
- Initial full-suite attempts exhausted **inodes** in `/tmp` (1,048,517/1,048,576 inodes used, not byte capacity): commit tier exit 1, 142 failed / 695 passed; E2E exit 1, 3 failed / 2 passed. Those logs are retained as `*-enospc.log`. Successful reruns used an isolated disk-backed `TMPDIR=/home/mark/f124-EjMDIk`, without test/config changes. No process with that unique TMPDIR remained; its directory was removed.
- Standalone requested crash probe: **exit 1, 1 blocked journey**, 7 true/2 false observations in `checks` (not ten independent acceptance tests). The ordinary E2E suite's green results do not override this failure.
