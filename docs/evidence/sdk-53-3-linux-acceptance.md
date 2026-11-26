# FOU-153: post-merge Linux SDK Tool Set acceptance

**Observed result: supported on Linux for the listed FOU-153 criteria. Independent
review pending; no PR or ticket transition authorized by this report.**

This is a new acceptance run against merged remediation, not a relabeling of prior
failure evidence. [Historical blocked evidence](sdk-53-3-linux.md) and all its
artifacts remain unchanged. [FOU-163 candidate evidence](sdk-agent-collision-linux.md)
remains the implementation candidate's observations, distinct from this rerun.
No macOS observation, waiver, complete-launcher qualification, reconnect or prompted
conversation-history recovery claim is made.

## Live scope and disposition

Read the complete current FOU-153 body, dependency relations and comments (none).
It is In Progress; FOU-163, FOU-147 and FOU-138 are Done. The criterion is positive
actual-host named/source mismatch holds for missing/reserved/agent-name tools and
clearing inherited extensions. PRD §17.2–3 resource-isolation bullets remain the
contract. New evidence covers those observations and the requested unchanged and
corrected unfreeze controls. No product/testkit/automated-suite changes were made.
Fresh independent review must assess these branch-only observations before the
parent authorizes an acceptance PR or ticket closure.

## Provenance and versions

Fresh acceptance branch `marklabrecque/fou-153-postmerge-acceptance` starts directly
at fetched `origin/develop` **`1bde222862fbf6d1d4ba311faa85cf62ee601c46`**, the merged
FOU-163 implementation, not the earlier feature history. The final retained probe,
source hashes and regression commands were executed on this exact revision plus
new uncommitted acceptance evidence only. No product diff existed at observation
time. No repository `AGENTS.md` was present in the tracked source tree.

- Linux `7.2.15-1-omarchy`, Node `v22.23.2`, npm `10.9.8`, pinned Pi `1.6.0`.
- `results/versions.json` records the launcher run's revision; full commit/tree,
  observation timestamp and SHA-256 of remediation source/tests, pinned lockfile,
  reused fixtures/recorders/drivers and new acceptance scripts are retained in
  `results/source-provenance.json`.
- Each actual host's read-only `identify` response records **controlVersion 5**,
  its owned state root, PID, host ID and boot ID. Inventory records actual owned
  launch identity, liveness/exit and agent collision diagnostic.
- The first bootstrap attempt found dependencies absent (`tsc`/Pi package missing).
  This was an observation-environment error before any worker launch, not a product
  failure. `npm ci` restored pinned dependencies (exit 0); subsequent build, actual
  probe and checks passed. Its sanitized install output is retained. Earlier
  calibration runs are not substituted for the final retained observations.

## Per-criterion actual-host observations

| Criterion | Retained positive evidence | Outcome |
| --- | --- | --- |
| Missing named tool | `hold list` identifies `frozen_slot`; `hold show` has `cause: tool_set_mismatch`, `missing: [{name: probe_absent, source: …/fixtures/missing.ts}]`; slot JSON is frozen, one launch ended requested | Verified |
| Reserved Pi collision | Named frozen hold: `replaced: [{name: read, expected: builtin:read, actual: …/fixtures/reserved.ts}]`; slot frozen, one requested launch end | Verified |
| Agent-name collision | Actual host inventory carries `agent_tool_collision` from loader registrations; actual `hold list/show` exposes frozen `tool_set_mismatch` with `agent_message`, expected `…/packages/extension/dist/index.js`, actual `…/fixtures/agent-name.ts`. No fabricated hello/session marker | Verified |
| Freeze/no generic churn/no slot work observed | All three initial mismatches have exactly one host launch, frozen slot JSON and requested end, not parked recovery. Ticket list empty and full daemon snapshots show no assignments/deliveries/relaunch. Unchanged recheck is only an explicit operator request | Verified within this unprompted fixture |
| Cleared/inheriting controls | No holds; both actual hellos accepted. Cleared has 12 fixed tools, no `named.ts`/`probe_named` in argv or fixture markers. Inheriting has 13 tools, named fixture load/session markers and active `probe_named` attributed to `named.ts` | Verified |
| Unchanged unfreeze | CLI exit 1, same named/source hold refreshed, still frozen, exactly second collision launch ended requested. No generic replacement churn | Verified |
| Corrected YAML + restart/unfreeze | Only disposable YAML changes `agent-name.ts` to `named.ts` (both YAML strings retained). Daemon restart leaves frozen hold. Unfreeze exits 0; new hello accepted with 13 tools, hold resolved, slot normal | Verified |
| Same conversation | All three agent launch argv `--session-id` values equal the original hold's conversation reference. Exactly three launches, first two requested ends; final corrected launch live until owned shutdown | Verified reference continuity, not prompted history |
| Owned cleanup | Every result has shutdown exit 0, no remaining recorded PGID members, daemon exited and root removed | Verified |

The final run contains **seven launches**: missing 1, reserved 1, cleared/inherit 2,
agent 3 (initial collision, explicit refused recheck, corrected recheck). Two collision
exception records retain the real source conflict; corrected recheck succeeds.
All seven network markers are `{fetchCalls: 0, denied: true}`. This is **zero
intercepted fetch attempts, not an OS-wide network-isolation proof**.

No tickets or prompts are submitted: “no slot work observed” means the empty-ticket
snapshot, frozen/ended launch state and no assignment/delivery in retained logs.
It is not an extra busy-work/adversarial admission experiment. The merged cheaper
boundary regressions own the general scheduler behavior. No model/tool-call
capability, priming or execution-replay proof is inferred.

## Exact runtime, effective fixtures and reproduction

The existing candidate driver is reused unchanged. The new `run-probe.mjs` adds
only read-only host identity/inventory, full daemon logs, ticket/slot JSON and
corrected YAML snapshots using single-match checked source splices. It writes a
same-directory temporary module and removes it in `finally`. All fixture behavior
and discrepancy product logic remain in the merged files; no duplicated product
classifier or substitute host is introduced.

Each variant's exact ordered argv, cwd, YAML, validation, source-bearing holds and
process/registry/network markers are in `sdk-53-3-linux-acceptance/results/`.
The real launcher is:

```
FOUNDRY_WORKER_RUNTIME=sdk <NODE> <REPO>/packages/daemon/dist/main.js
  --home <root>/home <root>/factory.yaml
  -> detached actual Worker Host (control protocol 5)
  -> <NODE> <REPO>/packages/host/dist/sdk-worker.js
       --mode rpc --system-prompt "" --append-system-prompt ""
       --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
       --no-context-files --no-approve --session-id <conversation>
       --model openai/gpt-4.1-mini
       --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request[,probe_absent|,probe_named]
       --extension <REPO>/packages/extension/dist/index.js
       [--extension <REPO>/docs/evidence/rpc-53-3-linux/fixtures/<fixture>.ts]
cwd: <root>/home/slots/probe/<station>-1
```

`--mode rpc` is shared resource-selection argv, not an RPC worker. SDK selection
and entrypoint are checked explicitly. `FOUNDRY_PI_BIN` is unset; no shim is used.

Missing uses `missing.ts`, which registers `probe_unnamed` while YAML names
`probe_absent`. Reserved uses `reserved.ts` registering `probe_named` and `read`,
YAML naming only `probe_named`. Agent uses `agent-name.ts` registering `probe_named`
and `agent_message`, YAML naming only `probe_named`. Cleared inherits factory default
`named.ts`/`[probe_named]` on one station and overrides `extensions: []` on the other.
All use local Git source `./repo`, neutral worktree slots and required writing/
approval stages. Model selection is built-in metadata only with deliberately fake
disposable `auth.json` `{"openai":{"type":"api_key","key":"none"}}`; no real
credential, provider extension, prompt, paid model request or model execution.

From repository root:

```sh
npm ci
npm run build
mkdir -p "$HOME/f153a"
env -u FOUNDRY_PI_BIN TMPDIR="$HOME/f153a" node docs/evidence/sdk-53-3-linux-acceptance/run-probe.mjs docs/evidence/sdk-53-3-linux-acceptance/results
env -u FOUNDRY_PI_BIN TMPDIR="$HOME/f153a" PI_OFFLINE=1 node docs/evidence/sdk-53-3-linux/inspect-load.mjs > docs/evidence/sdk-53-3-linux-acceptance/results/loader-errors.json
node docs/evidence/sdk-53-3-linux-acceptance/check-observations.mjs > docs/evidence/sdk-53-3-linux-acceptance/results/assessment.json
node docs/evidence/sdk-53-3-linux-acceptance/run-checks.mjs
node docs/evidence/sdk-53-3-linux-acceptance/collect-provenance.mjs
node docs/evidence/sdk-53-3-linux-acceptance/normalize-evidence.mjs
```

Probe, diagnostic and acceptance checker all exit **0** on the retained run. The
standalone loader diagnostic is supplemental; actual-host hold/inventory evidence
is required and retained. The acceptance checker delegates existing discrepancy
assertions, then fails on missing required acceptance snapshots, wrong protocol,
errors/CLI failures, incorrect initial freezes, wrong counts, generic churn, work
observations, changed correction scope, bad cleanup or recheck invariants. It checks
the listed fixture contract, not every PRD requirement or an entire release oracle.

## Normal regression validation

`run-checks.mjs` reuses the merged ordinary runner and redirects only this report's
output and owned short temp prefix. It explicitly removes `FOUNDRY_PI_BIN`, uses
short private home-backed TMPDIR propagated to children by the shared testkit, and
removes its root afterwards. No shim, timeout widening or cache deletion.

| Command | Exit / final counts |
| --- | --- |
| `npm run build` | 0 |
| `npm run typecheck` | 0 |
| direct `./node_modules/.bin/oxlint` | 0, no diagnostics |
| direct `./node_modules/.bin/vitest run` | 0; **103 files / 848 tests passed** |
| separate `npm run test:e2e` | 0; **3 files / 5 tests passed** |
| `git diff --check` (including staged new evidence before commit) | 0 |

Exact command/status records and sanitized outputs are under `checks/`. This is
manual process-boundary acceptance, not an added timing-dependent commit-tier test.
Green regressions do not replace the positive operator-visible evidence above.

## Safety, ownership, upgrade and normalization

Only newly created disposable `fou163-*` variant roots under the short private
acceptance temp parent were used. Each owns its own HOME, XDG, Pi agent/auth/settings,
local repository, Foundry state root and fresh protocol-5 host. `PI_OFFLINE=1`,
telemetry off; preload fetch denial is installed before SDK initialization. No
production host, operator `~/.pi`/Foundry/config state, 1Password, real credentials,
real provider or unrelated cache/process group was accessed or modified.

Host control changed **4 → 5** in merged remediation. A real running old host must
undergo an **operator-controlled shutdown and restart** with the matching new
host/daemon before use; an old host is not silently upgraded or compatible. This
run starts fresh isolated v5 hosts only. It performs a disposable daemon restart,
not an operator-host upgrade, and never touches any real running host.

Shutdown is addressed only to each fixture's state root. Marker-attributed PID/PGID
and launch IDs identify the exact groups; the recorder/checker require PID=PGID.
Cleanup checks only those recorded groups via `ps`, waits for daemon exit, then
removes only the owned root. Every final result has `remaining: []`,
`daemonExited: true`, `rootRemoved: true`. No active-work/escalation stop gate is
claimed. The runner's temp root is also removed; retained evidence is outside it.

Artifacts normalize `<REPO>`, `<NODE>`, `<HOME>`, `<PROBE_TMP>`, `<CHECK_ROOT>` and
`<SYSTEM_TMP>` only. UUIDs, PID/PGIDs, argv order, paths relative to source and hashes
are preserved. Use portable commands rather than executing placeholder argv.
Historical blocked artifacts and candidate observations remain untouched.

**Handoff:** positive Linux observations are now recorded for the original criterion;
stop before PR pending fresh independent review. No ticket closure, release
qualification or Mac claim is made by this evidence-only branch.
