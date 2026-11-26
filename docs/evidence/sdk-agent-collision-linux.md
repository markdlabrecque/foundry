# SDK pre-hello agent-tool collision — Linux implementation candidate

FOU-163. **Candidate observations pass; not the separate FOU-153 acceptance rerun.**
FOU-153 remains open pending its post-merge acceptance journey. No macOS claim,
release qualification, waiver, provider call or extension reconnect claim is made.
The earlier `sdk-53-3-linux.md`, results and failure checker remain unchanged and
historical: they correctly describe the earlier generic parked-slot failure.

## Provenance and implementation

Fresh base: `43f703492834f9a2b558718094c737cfb0166da7` (`origin/develop`).
Tested product/test/driver candidate: `ef1d079e91bdb8b2ce59a6663cebe371e73e4838`.
Later evidence-only commit adds this report and normalized observations; no source
changes. `sdk-agent-collision-linux/results/source-provenance.json` records the
full candidate/tree, empty tracked diff at observation time and SHA-256 of every
changed source/test/driver. Versions: Linux `7.2.15-1-omarchy`, Node `v22.23.2`,
npm `10.9.8`, pinned Pi `1.6.0`.

Pi's public `DefaultResourceLoader.getExtensions()` returns both error diagnostics
and all conflicting extension registrations. Its pinned resource loader explicitly
keeps all extensions on conflict. Each extension has its actual `path` and `tools`
map. `sdk-session.ts` identifies duplicate agent registrations there, before model
selection/session creation/bind/hello. It does **not** parse stderr or invent source
attribution, missing registrations or a successful hello. Ordinary loader errors
retain the generic startup path. Collision rejection/allowlists are not weakened.

The SDK worker writes versioned structured evidence to host-created fd 3. The host
reads at most 64 KiB, rejects malformed/oversized/non-agent diagnostics, attaches
its own launch identity and retains the report in inventory and exit events. It
finishes the diagnostic read before publishing the exit, so inventory cannot race
an incomplete diagnostic into crash recovery. Drain uses the existing bounded
1-second exit-report deadline; no test timeout was increased. Groups observed
empty at leader exit are never signalled again while the diagnostic drains.

The daemon re-confirms diagnostic events through the current host inventory and
requires matching current slot/launch, factory, boot and recorded PID. The conflict
must include the expected Foundry source and an extension configured for that slot,
using existing source canonicalization and `expectedToolSet`. Only the positive
conflict becomes a `replaced` discrepancy: “actual” here means the conflicting
loader registration, **not** a successfully activated session tool. The existing
frozen `tool_set_mismatch` hold, delivery revocation, owned-group termination and
same-conversation unfreeze checks are reused. Its failed launch is recorded as
requested, not counted toward generic recovery. Retained inventory also handles a
missed daemon event or a same-host launch reply lost before persistence.

Host control protocol is bumped **4 → 5**. A running old host is rejected, not
silently decoded without evidence; normal operator-controlled host shutdown/restart
is needed when upgrading. No database migration. No changes to
`packages/extension/src/worker.ts` or extension reconnect/channel retry lifecycle;
FOU-162's ownership is untouched.

## Red/green and checks

Cheapest regression tiers:

- Pure registration classification and bounded diagnostic decoding: two unit tests;
  positive duplicate sources, unrelated registrations/errors, malformed, non-agent
  and oversized payloads. Initial module-absent run failed before implementation.
- Existing host-owned launch integration fixture additionally sends fd-3 evidence;
  event, wire decoding and reconnect inventory preserve it with host identity.
- Existing SQLite scheduler/host-report boundary fixture covers valid current
  collision, nonexistent/wrong-factory report, genuinely stale retained collision,
  neighboring slot, unrelated startup error, named hold, owned termination, zero
  recovery increment and no replacement launch for the frozen slot.

The new boundary assertion was also run with **baseline `slots.ts` and `main.ts`**
compiled successfully (build exit 0), then restored to the implementation. It failed
on the required frozen named hold (`expected [] to match ... frozen_slot`), proving
the missing behavior rather than a syntax/import failure. See
`checks/red-baseline-boundary.log`. Final implementation passes that same assertion.
No new omnibus E2E, weaker assertion, shim or timeout widening.

Final ordinary commands, candidate above, `FOUNDRY_PI_BIN` unset:

| Command | Result |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| direct `./node_modules/.bin/oxlint` | exit 0, no diagnostics |
| direct `./node_modules/.bin/vitest run` | **103 files / 848 tests passed** |
| separate `npm run test:e2e` | **3 files / 5 tests passed** |

`run-checks.mjs` creates a short owned home-backed TMPDIR, propagates it to children
via the merged shared testkit, records each command/status and removes only that
root. `checks/` retains outputs and status. The system `/tmp` inode issue was not
worked around with cache deletion, environment-global settings or a Pi wrapper.

## Actual SDK observations

The portable driver reuses the existing RPC fixtures and SDK process/fetch recorder,
with checked single-match splices. It uses built-in `openai/gpt-4.1-mini` metadata,
disposable `auth.json` with exactly fake `none`, offline mode and pre-import
fetch-denial. No prompts or provider calls. The cleared station needs no provider
extension. Every launch explicitly receives home-backed TMPDIR.

| Variant | Actual operator/runtime observation |
| --- | --- |
| Missing | `hold show` names `probe_absent` and `fixtures/missing.ts`; `dev/1` frozen `tool_set_mismatch`, launch ended requested. One launch. |
| Reserved | `read`, expected `builtin:read`, actual `fixtures/reserved.ts`; frozen named hold, requested end. One launch. |
| Cleared/inherit | Both accepted; cleared reports 12 fixed tools, has no inherited fixture/tool argv or markers; inherit reports 13 and `probe_named` from `fixtures/named.ts`. No holds. Two launches. |
| Agent collision | `hold list`/`hold show` expose **frozen_slot**, `tool_set_mismatch`, `agent_message`, expected `packages/extension/dist/index.js`, actual `fixtures/agent-name.ts`. Slot CLI says frozen, launch ended requested. No collision hello/session marker, and no generic replacement churn. |
| Uncorrected unfreeze | Existing unfreeze refuses (exit 1), refreshes the same named/source hold for the second collision launch; remains frozen rather than timing out or parking. |
| Corrected unfreeze | Only disposable YAML is corrected to `named.ts`; ordinary daemon restart retains frozen hold. Existing unfreeze succeeds (exit 0), accepts 13-tool hello, resolves the hold and returns the slot to normal. Third launch only; all three argv `--session-id` values equal the original hold's conversation reference. This proves reference continuity, not recovery of prompted history (none was created). |

There are exactly **seven launches**: 1 missing + 1 reserved + 2 controls + 3 agent
(initial collision, explicit failed recheck, corrected recheck). The two collision
launches have positive registration exception diagnostics; the corrected launch
succeeds. Standalone `loader-errors.json` independently retains Pi's own conflict
text, but is not substituted for the actual-host hold evidence.

Each variant's JSON preserves effective YAML, validation, actual CLI holds/slots,
argv, markers, launch/group IDs, cleanup and (for agent) both rechecks and corrected
hello. `check-observations.mjs` verifies selected retained observations, including
source-bearing holds, same conversation, three agent launches and controls. It is
not a comprehensive qualification oracle and does not close FOU-153.

## Reproduction

From repository root, after `npm ci`, with a short private home-backed temp parent:

```sh
npm run build
mkdir -p "$HOME/f163"
TMPDIR="$HOME/f163" node docs/evidence/sdk-agent-collision-linux/run-probe.mjs docs/evidence/sdk-agent-collision-linux/results
TMPDIR="$HOME/f163" PI_OFFLINE=1 node docs/evidence/sdk-53-3-linux/inspect-load.mjs > docs/evidence/sdk-agent-collision-linux/results/loader-errors.json
node docs/evidence/sdk-agent-collision-linux/check-observations.mjs > docs/evidence/sdk-agent-collision-linux/results/assessment.json
node docs/evidence/sdk-agent-collision-linux/run-checks.mjs
node docs/evidence/sdk-agent-collision-linux/normalize-evidence.mjs
```

Actual launcher is `<NODE> <REPO>/packages/host/dist/sdk-worker.js` selected by
`FOUNDRY_WORKER_RUNTIME=sdk`, not the Pi RPC CLI. Full argv arrays are retained.
`--mode rpc` is shared resource-selection argv, not a separate RPC runtime.

## Isolation, cleanup and residual limits

Every variant owns a new `fou163-*` root, fake auth, HOME/XDG/agent directories,
local Git repository, factory config/state and neutral slot folders. No production,
operator config/state, credentials, 1Password, paid provider or global settings.
All **seven** recorded network counters are `{fetchCalls: 0, denied: true}`; this
is a fetch guard, **not** an OS-wide network-isolation claim.

Cleanup uses only recorded, marker-attributed owned PGIDs and this instance's
`shutdown --force`. Every variant records `remaining: []`, `daemonExited: true`,
`rootRemoved: true`. The regression runner removes its own temp root. Diagnostic
logs retained under the short temp parent are owned task artifacts, not live
workers. No unrelated temporary/config/cache trees were deleted.

Artifacts normalize `<REPO>`, `<NODE>`, `<HOME>`, `<PROBE_TMP>`, `<CHECK_ROOT>` and
`<SYSTEM_TMP>` only; UUIDs, PIDs/PGIDs, argv order and source suffixes are preserved.
Historical FOU-153 artifacts are not relabelled as a pass. Independent parent review,
CI, merge and the separately owned post-merge acceptance rerun remain outstanding.
