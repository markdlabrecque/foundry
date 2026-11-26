# RPC gate decision: select the SDK trial, not a qualified launcher

Ticket: [FOU-136](https://linear.app/foundry-mdl/issue/FOU-136/record-the-rpc-gate-decision), draft 55a. Contract: [PRD §17.2](../../prd.md#172-launch-gates-not-yet-passed). Recorded against `develop` at [`edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9`](https://github.com/markdlabrecque/foundry/commit/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9), with the live ticket's explicit activation condition: **one reproduced RPC failure is sufficient to select SDK for trial; selecting RPC requires every case to pass.** Pending or inconclusive cases alone select neither.

## Decision

**Select the SDK fallback for trial. Do not qualify RPC or SDK for P0 release.** Linux survival/reconnect (52a, FOU-83) reproduced a failure of the tested Foundry RPC approach: the original busy workers survive but never reconnect or resume channel traffic. This satisfies the SDK activation condition without waiting for the outstanding RPC cases.

This is a decision to investigate and validate the alternative, not evidence that SDK fixes the defect. The observed cause is missing reconnect in Foundry's extension, not demonstrated intrinsic RPC impossibility. An SDK worker reusing that channel code would also need reconnect implemented and proven. No product implementation, launcher default, acceptance criterion or P0 scope is changed here.

## Evidence provenance

The [build plan](../p0-build-plan.md) keeps investigation evidence in `docs/evidence/`. This decision follows that convention rather than recording a permanent architecture choice in an ADR.

- Six case records below are already on `develop` at the pinned base above. Their links are commit-pinned, not moving branch links. Their recorded outcomes, not tracker `Done` status, determine whether they passed.
- The decisive Linux survival evidence is **not yet merged into this base**. It is read directly from the FOU-83 branch, [`marklabrecque/fou-83-check-rpc-survival-and-reconnect-on`](https://github.com/markdlabrecque/foundry/tree/marklabrecque/fou-83-check-rpc-survival-and-reconnect-on), pinned at [`36724db3f0e9e7a0aa166801e72f0238ffaa9c5b`](https://github.com/markdlabrecque/foundry/commit/36724db3f0e9e7a0aa166801e72f0238ffaa9c5b). The source report, retained JSON and both scripts were read; they are linked below rather than copied or represented as merged evidence.
- That report records five runs, the final three consecutive at clean probe commit `d3770ba`, based on `edf3e0e` with probe-only changes. Its retained JSON is run 5. This decision's author did **not** rerun that probe. The independent review supplied in the implementation handoff additionally reports a rerun at `36724db3f0e9e7a0aa166801e72f0238ffaa9c5b` with the same nine passing checks and two failures over **45,048 ms**. That is attributed corroboration, not a new retained artifact or a measurement made by this decision's author. The commit-pinned source artifacts independently support the decision.
- No macOS run is inferred from Linux, integration tests, source inspection or the earlier throwaway spike. No operator state, credentials or production resources are needed for this record.

## All eight RPC cases

| Draft / ticket | Platform / case | Recorded result and scope | Durable evidence |
|---|---|---|---|
| 52a / [FOU-83](https://linear.app/foundry-mdl/issue/FOU-83/check-rpc-survival-and-reconnect-on-linux) | Linux survival and reconnect | **Reproduced failure / blocked on tested approach.** Two original busy workers and host survive daemon-only SIGKILL; launches and slots are unchanged, no replacements. Neither worker reconnects or resumes traffic. Passing criterion remains unmet. | [Unmerged report at 36724db](https://github.com/markdlabrecque/foundry/blob/36724db3f0e9e7a0aa166801e72f0238ffaa9c5b/docs/evidence/rpc-52-1-linux.md) |
| 52b / [FOU-92](https://linear.app/foundry-mdl/issue/FOU-92/check-rpc-survival-and-reconnect-on-macos) | macOS survival and reconnect | **Pending, not failed.** Live ticket is Backlog; no macOS survival evidence record exists at this base. No positive or negative runtime conclusion. | [Live requirement](https://linear.app/foundry-mdl/issue/FOU-92/check-rpc-survival-and-reconnect-on-macos) |
| 53a / [FOU-97](https://linear.app/foundry-mdl/issue/FOU-97/check-rpc-resource-isolation-and-named-tools-on-linux) | Linux resource isolation and named tools | **Supported on tested approach.** Positive configured model/skill/extension markers; ordinary global control detected; ambient resources excluded; cleared overrides effective; faux model calls the named tool, not the unnamed registration. Not all reserved agent tools were implemented in that revision. | [Merged report at edf3e0e](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/docs/evidence/rpc-53-2-linux.md) |
| 53b / [FOU-103](https://linear.app/foundry-mdl/issue/FOU-103/check-rpc-resource-isolation-and-named-tools-on-macos) | macOS resource isolation and named tools | **Inconclusive: platform unavailable.** No macOS execution. Tracker Done does not supply passing evidence or an RPC failure. | [Merged inconclusive record at edf3e0e](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/docs/evidence/rpc-53-2-macos.md) |
| 53c / [FOU-108](https://linear.app/foundry-mdl/issue/FOU-108/check-rpc-tool-set-mismatch-and-collision-on-linux) | Linux Tool Set mismatch and collision | **Supported for recorded variants.** Missing tool, reserved `read` collision and agent-name collision freeze with attributed holds; cleared station gets neither extension nor tool. No model call in this case. Agent-name result was `extra` while agent tools were unregistered, not proof of the later `replaced` behavior. | [Merged report at edf3e0e](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/docs/evidence/rpc-53-3-linux.md) |
| 53d / [FOU-115](https://linear.app/foundry-mdl/issue/FOU-115/check-rpc-tool-set-mismatch-and-collision-on-macos) | macOS Tool Set mismatch and collision | **Inconclusive: platform unavailable.** Source analysis and proposed fixtures are not runtime evidence. Not a pass or RPC failure. | [Merged inconclusive record at edf3e0e](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/docs/evidence/rpc-53-3-macos.md) |
| 54a / [FOU-122](https://linear.app/foundry-mdl/issue/FOU-122/check-rpc-explicit-stop-on-linux) | Linux explicit stop | **Supported on tested approach.** Three consecutive runs, all 13 checks true: scoped factory group departure, neighboring factory alive, bounded escalation of non-detached child, no owned groups after shutdown. Does not cover detached bash descendants after a forced Pi kill. | [Merged report at edf3e0e](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/docs/evidence/rpc-54-4-linux.md) |
| 54b / [FOU-128](https://linear.app/foundry-mdl/issue/FOU-128/check-rpc-explicit-stop-on-macos) | macOS explicit stop | **Inconclusive: platform unavailable.** No macOS observation of factory isolation, escalation or shutdown. Not a pass or RPC failure. | [Merged inconclusive record at edf3e0e](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/docs/evidence/rpc-54-4-macos.md) |

Summary: three supported Linux case records with their stated revision/fixture limits, one reproduced Linux failure, one pending macOS case, three inconclusive macOS cases. This is neither eight passes nor four macOS failures. Historical supported observations are not blanket qualification of later revisions.

## Decisive failure: what was actually observed

Pinned FOU-83 artifacts:

- [Report, versions, exact launcher, fixture and observations](https://github.com/markdlabrecque/foundry/blob/36724db3f0e9e7a0aa166801e72f0238ffaa9c5b/docs/evidence/rpc-52-1-linux.md)
- [Retained run-5 result.json](https://github.com/markdlabrecque/foundry/blob/36724db3f0e9e7a0aa166801e72f0238ffaa9c5b/docs/evidence/rpc-52-1-linux/result.json)
- [Driver and check definitions](https://github.com/markdlabrecque/foundry/blob/36724db3f0e9e7a0aa166801e72f0238ffaa9c5b/docs/evidence/rpc-52-1-linux/run-probe.mjs)
- [Busy-worker faux provider and held tool](https://github.com/markdlabrecque/foundry/blob/36724db3f0e9e7a0aa166801e72f0238ffaa9c5b/docs/evidence/rpc-52-1-linux/probe-extension.ts)

The retained run used Linux x86_64, kernel `7.2.15-1-omarchy`, Node `v22.23.2`, pinned Pi `1.6.0`, and the actual daemon → detached Worker Host → pinned Pi `rpc-entry` → Foundry extension chain, with no `FOUNDRY_PI_BIN` override. Both workers ran the credential-free `probe/busy` model inside held `probe_hold` calls in distinct slots. The report records argv, identity, isolated HOME/XDG/Pi directories, throwaway Git source and state root. There were accepted channels and heartbeats before the kill, so this was not a fixture that had never connected.

Run 5's JSON records **45,042 ms** after restart (distinct from the independently reported 45,048 ms rerun). The same host and original two worker PIDs remain live, the same launches occupy `hold/1` and `hold/2`, and no replacement or new held run appears. Both old daemon sockets disappear. Neither worker connects to the new daemon; there is no accepted hello or resumed frame traffic. Nine checks pass:

`fixtureShape`, `connectedBeforeKill`, `daemonKilledAbruptly`, `workersAndHostSurviveKill`, `sameHostAfterRestart`, `workersStillAlive`, `sameLaunchesInSlots`, `noReplacement`, `shutdownLeavesNothing`.

Two checks fail: **`reconnectedToRestartedDaemon`** and **`channelTrafficResumed`**. Shutdown and marker-scoped cleanup leave no fixture processes. Survival and identity preservation alone do not satisfy §17.2 item 1 or FOU-83's positive acceptance criterion.

The [worker extension at the evaluated base](https://github.com/markdlabrecque/foundry/blob/edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9/packages/extension/src/worker.ts) dials from `session_start`. Its channel-close handler clears `channel` without scheduling a retry; the failed-dial path also has no retry. There is no general reconnect/backoff loop. The daemon adopts the surviving launches and serves the socket, but no new worker hello arrives. This code inspection explains the reproduced failure; a bounded observation window alone would not establish intrinsic transport impossibility.

## Consequences and release hold

- The literal FOU-136 SDK-decision criterion is met by 52a's reproduced failure. Outstanding RPC cases do not delay this decision or early SDK work under [FOU-147](https://linear.app/foundry-mdl/issue/FOU-147/run-an-sdk-backed-worker-behind-the-host-seam).
- FOU-83's **passing** criterion remains unmet. This record does not relabel it as supported, close it, or substitute survival for reconnect. FOU-92 remains pending; the three recorded macOS inconclusive cases remain inconclusive.
- [FOU-145, positive launcher qualification](https://linear.app/foundry-mdl/issue/FOU-145/qualify-the-selected-launcher-for-p0-release), and downstream P0 release remain **held**. An SDK decision is not qualification. No production reliance on either launcher is authorized by this record.
- To qualify SDK, provide the same survival/reconnect, isolation/named-tool, mismatch/collision and explicit-stop evidence on **both Linux and macOS**, plus a working extension channel, conversation restoration after worker exit without implying execution replay, and fresh, recovery and compaction priming. Every required SDK scenario needs positive evidence, not just a working adapter or passing unit tests.
- To reconsider RPC qualification, fix and re-run the failed reconnect case, obtain the missing macOS observations, and establish positive evidence for every required case at the selected implementation. The current failure does not prove that such a repair is impossible.
- If neither launcher passes, headless launch stays blocked. No gate is weakened, no missing scenario is waived, and no adjacent product or broad planning change is included here.
