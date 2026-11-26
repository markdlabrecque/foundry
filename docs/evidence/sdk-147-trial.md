# FOU-147: SDK launch adapter trial (not launcher qualification)

## Authorization and limits

The live issue permits SDK work after **any one reproducibly failed RPC gate**;
remaining RPC gates and the decision write-up are not prerequisites. The coordinating
thread supplied an independent reproduction on FOU-83 revision `36724db3`: after a
daemon kill, both original workers survived with unchanged launch identities and no
replacements, but neither reconnected or carried traffic for 45 seconds. This was a
missing Foundry extension redial, **not evidence that RPC inherently cannot work**.
That reproduction was not rerun as part of this implementation.

This is the narrowly authorized SDK trial. It is not an SDK reconnect remedy, an
RPC rejection, or evidence that either launcher passes PRD §17.2.

## Design and selection

- RPC is still the default. `FOUNDRY_WORKER_RUNTIME=sdk` on the daemon explicitly
  selects the built host package's `sdk-worker.js`; `rpc` or unset keeps RPC.
  Unknown selectors fail, and an SDK selection rejects `FOUNDRY_PI_BIN` rather
  than silently replacing the adapter.
- Both routes consume the existing validated launch argv: exact model, skill and
  extension paths, fixed plus station-named tool list, conversation reference and
  neutral slot folder. SDK consumes these resource flags with Pi's parser but
  does not start an RPC server or accept commands on stdin.
- The host issues the launch identity and still owns the process group. The SDK
  binds the same on-disk Foundry extension, so `hello` and tool-source paths use
  the unchanged channel/ownership contracts. No parallel transport was added.
- The SDK loader disables ambient discovery, context files, MCP, system prompt
  files and resource settings. Configured paths remain explicit. The exact model
  is selected before extension startup can receive channel delivery. Missing
  registered models or extension load errors fail the launch.
- The SDK stores its conversation beneath the neutral slot folder in `sessions`.
  It can locate that SDK conversation by its explicit ID. Restoration after exit,
  RPC-to-SDK history migration and priming variants are **not qualified here**.
- Host environment inheritance is unchanged and unfiltered, as required by §3.2;
  this adapter is not a credential sandbox. Tests use disposable home, config,
  agent, session and slot locations, offline mode and the credential-free faux
  provider. No production or operator state is used.

## Verification

Implementation revision: `fc229ceca019ff545f0aa181c999dfb5469714ba`, rebased onto
then-latest `origin/develop` `edf3e0e6279dfd20cc1c7201fd7fdf31068a15d9` before the
full validation run. Linux, Node `v22.23.2`, npm `10.9.8`, pinned Pi `1.6.0`.

- `npm ci`: exit 0, zero audit vulnerabilities.
- `npm run build`: exit 0.
- `npm run typecheck`: exit 0.
- Direct `./node_modules/.bin/oxlint`: exit 0, empty diagnostics (captured explicitly).
- Direct `./node_modules/.bin/vitest run`: exit 0; **98 files, 821 tests passed**.
- Separate `./node_modules/.bin/vitest run --config vitest.e2e.config.ts`:
  exit 0; **3 files, 5 tests passed**.
- Targeted launch/SDK tests: **2 files, 18 tests passed**.

The new unit case proves explicit selector/resource argv and cleared resource lists.
The integration case launches a real SDK worker through the host registry, verifies
host-authenticated launch identity and the exact twelve fixed tools, and sends a
message over the existing channel. The faux model calls `agent_discover`; the real
submission/store handler commits it and the worker receives its successful result.
A configured observer verifies the effective faux model and skill path in the turn's
system prompt. Disposable global context/system files and an ambient extension do
not load; a global `defaultTools: [ls]` does not replace the explicit Tool Set.

This integration case is an adapter smoke test, **not** the comprehensive resource
isolation gate: it does not calibrate ordinary-launch discoverability or run every
malicious extension/MCP/clearing fixture from §17.2.

## Handoff

Fresh independent review is required. No PR, merge or tracker edits were made.
Remaining SDK gates include Linux/macOS survival and reconnect, full resource
isolation, explicit-stop/process-group evidence, restoration after worker exit,
and fresh/recovery/compaction priming. Shared extension redial remains unchanged;
using the SDK does not by itself fix the reproduced RPC reconnect failure.
