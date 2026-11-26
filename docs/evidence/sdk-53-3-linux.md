# SDK Tool Set mismatch/collision gate — Linux (FOU-153, draft 56j)

## Verdict: blocked on the tested fixture approach; gate inconclusive

**No passing qualification evidence. Do not close the original passing criterion.**
The actual SDK Worker Host starts its workers, but the reused disposable
extension-independent provider fixture cannot resolve its model. The worker exits
before binding extensions or sending `hello`:

```
Error: SDK model is not registered: probe-local/inert
    at createSdkSession (.../packages/host/dist/sdk-session.js:53:19)
    at async .../packages/host/dist/sdk-worker.js:10:21
```

This is not a demonstrated Tool Set comparison failure, nor evidence that the SDK
platform is unavailable or inherently incapable. It is a reproducible limitation
of this adapter with this fixture. `createSdkSession` explicitly passes
`modelsPath: null` to `ModelRuntime.create`, whereas the sibling RPC probe relies
on the isolated agent directory's `models.json`. No model request was attempted.
Three probe invocations (each with the host's three bounded launch attempts)
reached no hello; the last retains uncaught-exception records. Earlier invocations
had insufficient error observation; those are not additional gate observations.

Following the first reproducible prerequisite failure, the remaining variants were
not run. No product fix, replacement provider extension, paid real model, global
configuration experiment, or weakened gate was introduced to force a pass.

| Required observation | Status |
| --- | --- |
| Missing named tool freezes slot; hold names discrepancy and source | **Unverified**: missing variant launched, but model selection failed before hello. Hold list reported no open holds. |
| Reserved Pi `read` collision refused with fixture source | **Unverified**, not run after prerequisite failure. |
| Agent-name `agent_message` collision refused with fixture source | **Unverified**, not run. |
| Cleared station gets neither inherited extension nor tools; inheriting positive control gets both | **Unverified**, not run. |
| Actual SDK host / pinned Pi / disposable fixtures / owned cleanup | **Verified** for the missing variant; see artifacts below. |

Independent prerequisite remediation: explicitly decide whether the SDK adapter
should support the isolated `models.json` model source and, if so, address that in
separate authorized work. Then rerun all four variants, including the cleared
station's inheriting positive control. An extension-provided faux model alone is
not a substitute: `extensions: []` would clear its provider too. Collision/freeze
qualification still needs its own observations after that prerequisite is resolved.
The shared extension's known one-shot channel dial/reconnect limitation is not
exercised or remedied by this work.

## Versions, launcher and effective fixture

Observed on Linux `7.2.15-1-omarchy`, Node `v22.23.2`, pinned Pi `1.6.0`, npm
`10.9.8`. Product/base revision `050145655c76a722afc6bce70ae422397e49872c`
(latest `origin/develop` at the pre-check fetch/rebase). Only this evidence and its
manual recorder/driver were added. No product code or automated tests changed.
Read PRD §17.2–3, [RPC sibling evidence](rpc-53-3-linux.md), and
[SDK adapter trial](sdk-147-trial.md). No root/nested repository `AGENTS.md` was
present in the tracked source tree.

Exact daemon invocation (paths in retained JSON are literal, not abbreviated):

```
FOUNDRY_WORKER_RUNTIME=sdk <node> <repo>/packages/daemon/dist/main.js \
  --home <root>/home <root>/factory.yaml
```

The actual host-generated worker argv is retained under `markers` in
[`results/missing.json`](sdk-53-3-linux/results/missing.json). Its entry is
`<repo>/packages/host/dist/sdk-worker.js`, not the RPC entry or a custom worker:

```
<node> <repo>/packages/host/dist/sdk-worker.js
  --mode rpc --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id <conversation> --model probe-local/inert
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_absent
  --extension <repo>/packages/extension/dist/index.js
  --extension <repo>/docs/evidence/rpc-53-3-linux/fixtures/missing.ts
cwd: <root>/home/slots/probe/dev-1
```

The `--mode rpc` spelling is the adapter's shared resource argv, **not** an RPC
worker: the entrypoint and process markers confirm explicit SDK selection.
`FOUNDRY_PI_BIN` is absent. The fixture is the sibling's unmodified `missing.ts`
(registers only `probe_unnamed`); YAML names `probe_absent`. Full YAML and
`foundry validate` output are retained: validation exits 0 and resolves the twelve
fixed tool names plus `probe_absent` attributed to `missing.ts`. This is a
configuration observation, not proof of the worker's effective registry.

The sibling's local provider JSON is written into the disposable agent directory:
`probe-local/inert`, API `openai-completions`, URL `http://127.0.0.1:9/v1`, dummy
key `none`. It requires no extension, credentials, paid model or network call.
Pi SDK's model loader does not read it in this tested adapter. Fixture load
markers and session-start registry markers were absent, consistent with failure
before extension binding; absence here is not a negative resource-isolation pass.

## Driver, retained artifacts and isolation

Manual real-process wiring evidence is the cheapest sufficient tier: actual host,
SDK loading and on-disk resources cannot be proven by a pure logic test. No
polling/timing-dependent test was added to the commit-tier suite.

```
npm ci
npm run build
node docs/evidence/sdk-53-3-linux/run-probe.mjs docs/evidence/sdk-53-3-linux/results
```

Expected current exit: **1**, after retaining the missing variant and cleanup,
with `Stopped at missing; see retained result`. The driver reuses the sibling
`rpc-53-3-linux/run-probe.mjs` and all its fixtures, applying checked, single-match
probe-only splices into a temporary generated module. It does not duplicate
product comparison logic. It explicitly sets `FOUNDRY_WORKER_RUNTIME=sdk`, preserves
error/CLI observations on timeout, and stops before later variants on error.
Generated source is removed in `finally`.

`record-process.mjs` reuses the sibling argv/output recorder and additionally
records `/proc/self/stat` PID/process-group IDs and uncaught exceptions without
handling/suppressing them. It is supplied solely through the isolated tree's
`NODE_OPTIONS=--import=<absolute recorder path>`. The exception monitor was needed
because Node's fatal exception was not present in the sibling stderr tee.

Retained sanitized evidence:

- `sdk-53-3-linux/results/versions.json`: product/Node/Pi/platform versions.
- `sdk-53-3-linux/results/missing.json`: exact factory YAML, validation, daemon
  launch/retry output, hold/slot CLI results, three SDK argv/process/exception
  records, shutdown and post-shutdown process-group absence. No secrets are
  present; paths, UUIDs and PIDs are retained for attribution.
- `sdk-53-3-linux/checks/`: complete regression check outputs, independent of the
  manual probe outcome.

Each attempt uses a new `/tmp/fou153-missing-*` root containing a local Git source,
HOME, XDG directories, Pi agent directory and Foundry state. The subprocess
environment is allowlisted by the sibling driver: no inherited credentials,
operator Git config, `~/.pi` or `~/.foundry`. `PI_OFFLINE=1`, telemetry off. No
1Password, production/operator resources or real provider calls were used.

Cleanup of the final run is proven in the result: marked worker groups
`2409930`, `2409960`, `2409945` (reproduction will issue new IDs)
are checked using `ps -eo pid=,pgid=,stat=,args=` filtered strictly to recorded
owned groups. The driver never sends signals to discovered arbitrary processes;
it requests the isolated instance's `shutdown --force`. Remaining members: `[]`;
daemon exited: `true`; disposable root removed: `true`. No worker was live by
shutdown (all had already exited on model selection); this does not qualify the
separate explicit-stop gate with active work or escalation.

Secondary observation: `hold list` exited 0 with no open holds, but `slot list`
and `slot show` exited 1 with `Expected "normal" | "frozen"`. This is a separate
management-CLI observation after early worker failures, not source/freeze evidence
and not the cause of SDK model selection failure. No fix or broader diagnosis is
included.

## Regression checks (independent of gate verdict)

After fetching and rebasing latest `origin/develop` (still `0501456`):

| Command | Exit / result |
| --- | --- |
| `npm ci` | 0, 268 packages added, 0 vulnerabilities |
| `npm run build` | 0 |
| `npm run typecheck` | 0 |
| direct `./node_modules/.bin/oxlint` | 0, empty diagnostics captured |
| direct `./node_modules/.bin/vitest run` | 0; 100 files, 837 tests passed |
| separate `./node_modules/.bin/vitest run --config vitest.e2e.config.ts` | 1; 2 files passed, 1 failed; 4 tests passed, 1 failed |
| same separate e2e command, one rerun | 1; 2 files passed, 1 failed; 2 tests passed, 3 failed |
| `node --check` both new manual `.mjs` files | 0 |

First e2e failure: worker-channel's launched faux-provider station assertion
received `undefined` rather than `dev/1`. Rerun failed earlier in all three
worker-channel journeys: fixture `git commit` could not create
`.git/logs/refs/heads/main` (`No such file or directory`). Cause/attribution of
these regression-suite failures is **unverified**; no test or product code was
changed to conceal them. They are not evidence for SDK mismatch support or failure.

Fresh independent review is still required. No PR, merge or tracker mutation was
performed. Passing the target gate remains unmet; collision and clearing results
must not be inferred from the prior RPC evidence or the SDK adapter smoke test.
