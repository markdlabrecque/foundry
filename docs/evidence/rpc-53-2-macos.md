# Evidence: RPC resource isolation and named tools on macOS

Ticket: [FOU-103](https://linear.app/foundry-mdl/issue/FOU-103/check-rpc-resource-isolation-and-named-tools-on-macos), draft 53b. Product contract: PRD §17.2 gate 2 (resource isolation) and §17.3 (a model actually calling a named extension tool). This record covers only this ticket, not the mismatch/collision variants in `rpc-53-3-macos.md`.

## Outcome

**Inconclusive: no macOS execution was available in the authorized Foundry worktree. Not a pass, and not a reproduced RPC failure.** No actual RPC Worker Host, ordinary Pi control, fixture or faux model was run on macOS. Local Linux verification does not count as macOS evidence. The RPC gate remains open; this record neither verifies FOU-103 as Done nor justifies selecting RPC or activating the SDK fallback.

| Required observation | macOS result |
|---|---|
| Ordinary Pi launch detects a disposable, discoverable global extension marker | Inconclusive — not run |
| Actual Worker Host launch connects the Foundry extension and uses the explicit model, configured skill and extension markers | Inconclusive — not run |
| Unconfigured global extension, global MCP and operator `defaultTools` cannot change the effective Tool Set | Inconclusive — not run |
| Global context and repository `.pi` resources do not load | Inconclusive — not run |
| Explicit empty station resource lists clear inheritance | Inconclusive — not run |
| A real faux model calls the YAML-named registered tool, while an additional registered but unnamed tool is absent | Inconclusive — not run |

## Availability observations (2026-11-25)

- Local `uname -a`: `Linux omarchy 7.2.15-1-omarchy #1 SMP PREEMPT_DYNAMIC Mon, 02 Nov 2026 10:32:17 +0000 x86_64 GNU/Linux`.
- Local Node `v22.23.2`, npm `10.9.8`. These are **not target-platform versions**. No macOS version, architecture or target Node version was measured.
- Foundry source inspected at `7c79cbd5b04729388055a14188e605b3bea40880`, the starting `origin/develop` commit of this T3-managed worktree.
- The authorized linked-environment registry reported “Mark’s MacBook Pro” reachable, with `approval-required` access. A reachable environment alone is not a successful target-platform execution.
- A read-only availability-check delegation targeting that environment and `pi` / `openai/gpt-6.1-sol` was refused before a child ran: `No project there has this repository (github.com/markdlabrecque/foundry). Pass target.projectId; t3_project_list with this environmentId lists them. To bring the repository there, use t3_project_clone and then t3_project_create with this environmentId.`
- The linked environment's project list confirmed no registered Foundry project (three projects, no further page). This does not prove that no unregistered checkout exists; none was searched for or accessed. This task restricts work to the prepared Foundry worktree, so no remote project was created, no unrelated project was used as an execution cwd, and no remote clone or fixture launch was attempted.
- No production server, 1Password credential, real operator Pi state or real operator Foundry state was accessed.

## Pinned runtime and exact launcher mapping (source inspection, not execution)

`packages/host/package.json`, `packages/extension/package.json` and `packages/testkit/package.json` pin `@earendil-works/pi-coding-agent` to **1.6.0**. The harness running this investigation is separate from that worker dependency. No Pi version command was run on macOS.

At the source commit above, `packages/host/src/launch-command.ts` resolves the default executable to `process.execPath` and the pinned package's `@earendil-works/pi-coding-agent/rpc-entry` export, provided `FOUNDRY_PI_BIN` is unset. Its literal argument mapping is below. Angle-bracket values are unresolved fixture inputs, **not captured argv**:

```text
<node> <resolved pinned Pi rpc-entry>
  --mode rpc
  --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id <conversationRef>
  --model foundry-faux/scripted
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,fixture_echo
  --extension <Foundry extension entry>
  --extension <faux provider extension>
  --extension <configured fixture extension>
  --skill <configured fixture skill>
```

The default RPC entry already prepends `--mode rpc`; the host deliberately also passes it. The cwd is the neutral per-slot directory under the disposable Foundry state root, not the source repository. The host copies its whole environment and then sets the factory, slot and launch identity variables. Isolation variables must therefore be applied to the process starting the daemon/Worker Host, not just CLI invocations. These mappings are preparation only: no effective fixture, resolved macOS paths, channel `hello`, model request or tool result exists for this attempt.

## Bounded rerun on macOS (not executed)

Use the actual RPC Worker Host and pinned worker Pi, with a disposable fixture adapted from `packages/daemon/e2e/worker-channel.e2e.test.ts`. This boundary needs a real worker/model integration observation: unit assertions about argv or a mocked tool call cannot prove resource discovery or actual model tool use.

1. Prepare an authorized T3-managed Foundry worktree on macOS. Record its commit, `sw_vers`, `uname -m`, Node/npm versions and the installed worker Pi version. Keep `FOUNDRY_PI_BIN` unset. Use only temporary source repositories, state roots and resource files; never copy operator configuration or credentials.
2. Start every process with an isolated environment, using the testkit's `isolatedGitEnv()` pattern plus disposable `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1` and `PI_TELEMETRY=0`. Pass a fresh `--home` state root. Do not spread the operator's environment or rely on an empty home as negative evidence.
3. In that disposable global agent directory, install an auto-discoverable extension with a unique marker, settings with a conflicting `defaultTools`, a local disposable MCP server and a marked global context file. Put separately marked `.pi` resources in the throwaway source repository. First demonstrate that ordinary pinned Pi, without Foundry suppression flags, discovers the global extension marker. Capture the baseline and exact command; if a control is not discoverable, its later absence proves nothing.
4. Configure an explicit `foundry-faux/scripted` model, the testkit's faux provider extension, a marked configured skill and a fixture extension registering `fixture_echo` and `fixture_unnamed`. Name only `fixture_echo` in that extension's YAML `tools`. Record both the source YAML and resolved effective station resources. Capture the real host executable, argv, cwd, accepted channel identity, effective model and positive configured markers; inspect model input/tool schemas and observable extension markers for the exclusions, not just the launch flags.
5. Have the faux provider emit an actual `fixture_echo` tool call. Preserve the model request showing `fixture_echo` available and `fixture_unnamed` absent, the tool-call event, returned marker and subsequent model turn. Report the remaining fixed Tool Set separately: “only named” means the fixture's unnamed tool is excluded, not that Pi's fixed tools disappear. A `hello` tool inventory alone is not a model call.
6. Exercise inherited configured resources and explicit empty station overrides. A skill-clear variant can keep the faux provider configured. For `extensions: []`, clearing the list also clears the faux provider: first establish a disposable model configuration independent of extensions, or record that variant as fixture-blocked. Do not classify an unknown-provider startup failure as successful inheritance clearing or a launcher failure. Check the actual effective resources, extension markers and tool inventory.
7. Stop after these observations or a reproducible failure. Capture exact commands, resolved paths (including macOS canonical path spellings), effective fixtures, sanitized outputs and cleanup of every owned worker/daemon/host/MCP process before removing temporary roots. Replace the inconclusive rows only with observed macOS results: supported, blocked on tested approaches, or inconclusive. Keep FOU-103 open until the required evidence is actually established.

No automated test or fixture is added by this record. Repository tests/typecheck/lint, if run for the documentation PR, validate repository health only and cannot change any macOS outcome above.
