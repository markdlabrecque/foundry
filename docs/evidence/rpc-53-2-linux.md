# Evidence: RPC resource isolation and named tools on Linux

Ticket: [FOU-97](https://linear.app/foundry-mdl/issue/FOU-97/check-rpc-resource-isolation-and-named-tools-on-linux), draft 53a. Contract: PRD §17.2 gate 2 (the isolation/configured-resource observations) and §17.3 (an actual named-tool model call). Mismatch, reserved-name collision and other platforms are outside this record.

## Outcome

**Supported on the tested Linux approach.** On 2026-11-25 the actual daemon → detached Worker Host → pinned Pi RPC entry → Foundry extension boundary accepted three launches. The configured faux model called only the YAML-named fixture tool and received its result. This is not a whole-gate or cross-platform launcher decision, and does not prove that every future YAML tool or arbitrary extension is safe.

| Required observation | Observed result |
|---|---|
| Discoverable global extension, ordinary-launch positive control | `GLOBAL_EXTENSION_53A` recorded for `ordinary` only |
| Explicit model overrides conflicting global defaults | `ctx.model` and assistant messages identify `probe-faux/scripted`, not `wrong-control/wrong-control` |
| Configured extension and skill effective | `configured-loaded`, both tool registrations, and `CONFIGURED_SKILL_53A` in the inherited worker's actual model input |
| Global MCP and `defaultTools` excluded | Ordinary input declares `grep` and `mcp__probe__ambient`; worker input instead declares `read,bash,edit,write,agent_discover,probe_named`, with neither ambient tool |
| Global context excluded | Ordinary input contains global `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` markers; worker model input contains none |
| Repository resources excluded | Disposable source has marked `.pi` extension, skill, settings and system prompt plus root context; none of their markers reaches workers; worker cwd is neutral, outside source |
| Station override clears inherited resources | `skillclear/1` retains configured extension/tool call but has no skill marker or `--skill`; `clear/1` has neither configured extension nor skill argv, no configured extension marker and accepted hello with five tools rather than six |
| Real model tool call, unnamed registration absent | Each configured worker emits one `probe_named({value:"CALL_MARKER_53A"})`, executes it and feeds `TOOL_RESULT_53A:CALL_MARKER_53A` into its second model request; `probe_unnamed` exists in the registry but not the model declaration |

The skill observation proves the indexed skill description/path is loaded, not that the model reads its body on demand. The separate §17.3 injected-repository-context journey is not claimed. Repository resources were planted in the source repository but no trusted ordinary repository baseline was run; the actual neutral-cwd launch and observed absence are the tested approach, not a claim about every repository trust mode.

## Reproduction and retained evidence

```sh
npm ci
npm run build
node docs/evidence/rpc-53-2-linux/run-probe.mjs /tmp/fou97-evidence-final
```

The driver is a bounded, one-off integration probe, not a new commit-suite test. Only this real boundary can prove ambient discovery and actual model calls. It uses the pi-ai faux provider (no credentials, no network calls) inside a configured extension. It creates all global controls, repository and Git history under a fresh temporary root; Git hooks are disabled for fixture commits. No operator configuration is copied. No production or 1Password resource is used.

Files:

- [`rpc-53-2-linux/run-probe.mjs`](rpc-53-2-linux/run-probe.mjs): complete setup, factory YAML, ordinary command, assertions, bounded waits and shutdown.
- [`rpc-53-2-linux/fixture.mjs`](rpc-53-2-linux/fixture.mjs): observable configured extension, genuine faux model responses and tool execution.
- [`rpc-53-2-linux/result.json`](rpc-53-2-linux/result.json): retained raw successful run, including `versions`, exact `ordinaryCommand`, `factoryYaml`, validation, slot identities, daemon log, shutdown and marker file contents. Marker strings contain JSON/JSONL or raw worker RPC stdout, not summaries. No secret values are present.
- The existing `rpc-53-3-linux/fixtures/record-argv.mjs` preload records actual worker argv before Pi changes `process.title` and tees RPC events; it does not replace the executable or alter tools/resources.

Three preliminary fixture-development attempts were not launcher failures: auto-discovery ignores `.mjs` extension filenames (changed disposable global/repository controls to `.ts`); Foundry skills require a file, not a directory (changed YAML to `./skill/SKILL.md`); faux context carries system tool declarations in `messages[].toolsAdded`, not `context.tools` (corrected assertion). These attempts were shut down and temporary roots removed. The retained run uses all corrections and passes, rather than treating failed controls as isolation evidence.

## Versions and exact launcher

- Foundry base: `16f17ee1f16d06bc4d5cec6eb5af0b1d0678f4a4` (`origin/develop` when run); probe files were uncommitted at execution.
- Worker Pi: **1.6.0**, installed from the repository lockfile; this is not the outer coding harness version.
- Node **v22.23.2**, npm **10.9.8**.
- `Linux omarchy 7.2.15-1-omarchy #1 SMP PREEMPT_DYNAMIC Mon, 02 Nov 2026 10:32:17 +0000 x86_64 GNU/Linux`.
- Disposable root: `/tmp/fou97-Gk2U48` (removed after shutdown).

In the following literal captured inherited-worker command, `$W` abbreviates only the recorded worktree path `/home/mark/worktress/main/scheduled-fou-97-gpt61-41b6789b5e4e70f8`. The JSON artifact retains every absolute argument without abbreviation:

```sh
/home/mark/.local/share/pi-node/node-v22.23.2-linux-x64/bin/node \
  "$W/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js" \
  --mode rpc --system-prompt '' --append-system-prompt '' \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve \
  --session-id 90fd32cc-fb30-4b75-9479-90c4b2163539 \
  --model probe-faux/scripted \
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request,probe_named \
  --extension "$W/packages/extension/dist/index.js" \
  --extension "$W/docs/evidence/rpc-53-2-linux/fixture.mjs" \
  --skill /tmp/fou97-Gk2U48/skill/SKILL.md
```

The session ID and all arguments are also recorded in the corresponding launch JSON inside `result.markers`. The cwd is `/tmp/fou97-Gk2U48/state/slots/probe/inherit-1`, not the fixture repository. The executable is the host's default pinned RPC entry; `FOUNDRY_PI_BIN` is unset. The RPC entry itself also prepends RPC mode. `NODE_OPTIONS` is only the recording preload. The driver starts the daemon with disposable `HOME`, `PI_CODING_AGENT_DIR`, all three XDG directories and offline/telemetry settings, using an explicit allowlisted environment rather than inheriting operator credentials. The host and workers inherit those same directories.

## Effective fixture and observations

Factory defaults select `probe-faux/scripted`, `./skill/SKILL.md`, and the configured extension object naming **only `probe_named`**. `inherit` inherits all defaults; `skillclear` sets `skills: []`; `clear` sets `skills: []`, `extensions: []`, and `model: probe-local/inert`. The last model is defined independently in disposable `models.json` at a closed loopback port; it is never called. Clearing extensions therefore does not cause an unknown-provider startup failure. Full source YAML is in `result.factoryYaml`, and `result.validate` records the resolved absolute extension path and expected Tool Sets.

At `16:21:13Z`, daemon `channel accepted` records:

| Slot | Launch | Observed tool count |
|---|---|---:|
| `inherit/1` | `2dbea945-2b8f-4071-8528-af6d3513ce21` | 6 |
| `skillclear/1` | `560681d0-f3d4-44a1-bb0b-c580cf3b81d9` | 6 |
| `clear/1` | `9b9ccf63-6305-4dff-bf0f-ab113a345f05` | 5 |

All three slot details report `condition: normal`, no freeze, and the host-started launch identity. There is no tool-set mismatch refusal. The configured extension records `ctx.model`, registry, active tools and system prompt at session start. Model input is separately recorded by the actual faux response factory, and worker RPC stdout contains the emitted tool call, execution result, final assistant message and settled event. The fixture registers both tools; the ordinary-control registry exposes both. Worker `getAllTools()` already filters out the unnamed registration, which is also absent from worker active tools and the model declaration. No driver invokes a tool implementation directly.

**Expected versus observed:** validation names 13 tools (12 fixed plus `probe_named`); this P0 build currently implements only `agent_discover` among the eight reserved agent tools. The observed active set is therefore six, not thirteen: four Pi built-ins, `agent_discover`, `probe_named`. Clearing extensions leaves five. The accepted channel's current mismatch policy allows fixed tools still unimplemented; this probe does not claim those other seven tools exist. “Only named” refers to the configured extension's two registrations, not to removal of the fixed tools. No adjacent implementation is added to make the counts look complete.

## Cleanup and limits

The driver runs `foundry shutdown --force` against only the disposable state root. Retained output: `factory probe stopped (3 worker(s))`, `worker host stopped`, `shutdown complete (forced)`. The ordinary Pi process is terminated before Foundry starts. A post-run process listing found no `fou97-` fixture process or recorded worker PID; disposable roots from the development attempts and retained run were removed. The local MCP process was launched only by ordinary Pi, not by any Foundry worker.

This is Linux evidence only, not a pass for macOS, collisions/missing registrations, explicit-stop isolation, compaction, recovery or the full launcher decision. No production code was changed.

## Repository validation and review

Independent Pi `openai/gpt-6.1-sol` review found no must-fixes for draft 53a. Its registry-wording clarification was applied. After fast-forwarding to `538bec2` (a concurrent discovery e2e-only change), full validation passed again: `npm run build`, `npm run typecheck`, direct `./node_modules/.bin/oxlint`, `npm test` (410 tests / 69 files), and `npm run test:e2e` (3 tests / 3 files). The initial `npm run lint` wrapper produced an RTK JSON parsing error; the direct repository lint executable exited zero. These health checks do not replace the retained Linux boundary observations above.
