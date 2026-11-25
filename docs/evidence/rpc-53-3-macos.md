# Evidence: RPC Tool Set mismatch and collision on macOS

Ticket: FOU-115 (draft 53d), under FOU-12 (launcher decision). Product contract: PRD §17.2 gate 2 (resource isolation: the Tool Set items) and §17.3 (the `--tools` behaviour was observed on macOS only, with no model call). Linux counterpart: FOU-108 (draft 53c).

## Outcome

| Check | Result |
|---|---|
| Missing named tool freezes the slot with a hold naming it | **Inconclusive (platform unavailable)** |
| Configured extension registering a reserved Pi tool (`read`) is refused, with its source shown | **Inconclusive (platform unavailable)** |
| Configured extension registering an agent tool name is refused, with its source shown | **Inconclusive (platform unavailable)** |
| Station with `extensions: []` gets neither the extension nor its tools | **Inconclusive (platform unavailable)** |

**Overall: inconclusive (platform unavailable). This is not a pass.** No macOS host was available to this run, and nothing was executed on macOS. Under FOU-136 an inconclusive case is neither positive evidence for RPC nor a reproduced failure. It does not count towards selecting RPC, and it does not activate SDK work (FOU-147). The gate stays open until this check runs on a real macOS machine.

No Linux result is recorded here. The same checks on Linux belong to FOU-108, and a Linux pass is not evidence for macOS. The macOS-specific risk is canonical source paths, for example `/var` versus `/private/var` under `mktemp -d`. `canonicalSource` in `packages/daemon/src/tool-set-check.ts` handles it, but no run has observed it.

## What was and wasn't tested

Tested: nothing on the target platform.

Checked on the run machine, which is not the target platform:

- That the machine is not macOS: `uname -a` reports Linux, `sw_vers` is absent and `/Applications` does not exist.
- The pinned versions and the exact launcher the Worker Host would use (below), read from this commit's code and `node_modules`.
- In Pi 1.6.0's source, how a tool-name collision arrives at the extension's `hello` report (below). This was read, not run.

Not tested, on any platform, by this ticket:

- Any launch through the RPC Worker Host, any `hello`, freeze, hold or launch stop.
- Any of the four fixture variants below.
- Any model call. The faux provider was not started.

## Versions and environment of this attempt

- Date: 2026-11-25.
- Machine: Linux (Omarchy, kernel `7.2.15-1-omarchy`, x86_64). **Not macOS.** No macOS version to record.
- Node `v22.23.2`, npm `10.9.8`.
- Pi coding agent `1.6.0` (`@earendil-works/pi-coding-agent`, pinned exactly in `packages/host`, `packages/extension` and `packages/testkit`). `pi --version` gives `1.6.0`.
- Foundry at `bc83e3b` (develop, after FOU-138 "Freeze workers with a mismatched Tool Set"). `REGISTERED_AGENT_TOOLS` is `[]` at this commit (FOU-36 not landed). So no agent tool is expected from the Foundry extension, and an agent tool any worker reports is an *extra* tool.

## Exact launcher (as built at `bc83e3b`)

`resolvePiExecutable` (`packages/host/src/launch-command.ts`): with no `FOUNDRY_PI_BIN`, the command is `process.execPath` running the pinned package's `rpc-entry` export, `node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js`. `buildLaunchArgs` produces:

```
<node> <pi>/dist/bundle/rpc-entry.js
  --mode rpc
  --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id <conversationRef>
  --model <provider/model>
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request[,<named extension tools>]
  --extension <foundry extension entry>
  [--extension <configured extension>]...
  [--skill <configured skill>]...
```

The cwd is the slot's neutral folder under the state root. The environment is the host's, plus `LAUNCH_ENV` identity.

## Fixture plan for the macOS run (not executed)

Each variant needs its own `mktemp -d` root, following `packages/daemon/e2e/worker-channel.e2e.test.ts`. Isolate `HOME`, `XDG_*` and `PI_CODING_AGENT_DIR`, and set `PI_OFFLINE=1` and `PI_TELEMETRY=0`. Use a fresh `--home` state root and a throwaway git source repository from `makeGitSource`. Every station uses the testkit's faux provider extension and model `foundry-faux/scripted`. Then:

| Variant | Station extensions (YAML) | Fixture extension registers | Expected observation |
|---|---|---|---|
| Missing named tool | `[{path: ./ext.ts, tools: [fixture_missing]}]` | nothing | `hello` refused `tool_set_mismatch`. Slot frozen, hold evidence `missing: [{name: fixture_missing, source: <ext.ts realpath>}]`. Launch stopped. |
| Reserved Pi tool collision | `[{path: ./ext.ts, tools: []}]` | `read` | Hold evidence `replaced: [{name: read, expected: builtin:read, actual: <ext.ts path>}]`. Launch stopped. |
| Agent-name collision | `[{path: ./ext.ts, tools: []}]` | `agent_message` | Hold evidence `extra: [{name: agent_message, source: <ext.ts path>}]` while `REGISTERED_AGENT_TOOLS` is empty, or `replaced` once FOU-36 lands. Launch stopped. |
| Cleared list | defaults name `./ext.ts` with `fixture_echo`, station sets `extensions: []` | `fixture_echo` | No `--extension ./ext.ts` on the launch argv, `fixture_echo` absent from `hello`, `hello` accepted. |

The YAML cannot name `read` or `agent_message` itself, because `checkToolNames` rejects reserved names at load. So the collisions come from an extension that registers a reserved name the YAML doesn't name. `--tools` still lets it through, because the name is in the fixed list. For each variant, record `foundry slot list --json`, the open hold (`kind: frozen_slot`, subject the slot ID, `evidence.cause: tool_set_mismatch`) and the rest of its evidence (`launchId`, `conversationRef`, `missing`, `extra`, `replaced`), the daemon log lines (`channel hello refused`), and the host's inventory showing the launch gone. The macOS check that matters is that `actual` and `source` paths under `/var/folders/...` compare equal to their `/private/var/...` realpaths. That means a correct variant must not freeze for a path spelling.

## How Pi 1.6.0 surfaces a collision, from source (not run)

- `dist/core/resource-loader.js`, `detectExtensionConflicts`: when two extensions register the same tool name, Pi records `Tool "<name>" conflicts with <path>` as an extension load error. Both extensions stay loaded, and load order decides which one wins.
- `dist/core/agent-session.js`, `_refreshToolRegistry`: built-ins enter the registry with source `builtin:<name>`, then each allowed extension tool is `set` over them. An extension registering `read` therefore *replaces* the built-in, and its `sourceInfo.path` is the extension's path. Pi emits no diagnostic for a built-in override.
- The Foundry extension reports each active tool with that source (`packages/extension/src/tool-set.ts`), and the daemon compares sources after `realpath` (`canonicalSource`). That is why a reserved-name collision should show as a replacement with its source, but no macOS run has confirmed it.

## To close this gate

Run the four variants above on a macOS machine with the same pinned Pi and Node 22 or later. Record `sw_vers`, the CPU architecture and the observations, and replace each "Inconclusive" row with the observed result.
