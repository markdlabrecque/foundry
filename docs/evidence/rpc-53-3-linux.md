# Evidence: RPC Tool Set mismatch and collision on Linux

Ticket: FOU-108 (draft 53c). Product contract: PRD §17.2 gate 2 ("Resource isolation"), these bullets:

- a YAML tool name that nothing registers freezes the slot with a hold naming it;
- a configured extension registering `read` or an agent tool name is refused, with its source shown;
- a station with `extensions: []` gets neither the extension nor its tools.

PRD §17.3 also notes that the `--tools` behaviour behind the Tool Set had been observed on macOS only. This run observes it on Linux, through the real launcher.

## Outcome

| Variant | Result | What the operator sees |
|---|---|---|
| `missing`: YAML names `probe_absent`, the extension never registers it | **Supported** | Slot `dev/1` frozen (`tool_set_mismatch`). The hold's evidence is `missing: [{"name":"probe_absent","source":"<repo>/…/fixtures/missing.ts"}]`. Launch stopped. |
| `reserved`: a configured extension registers `read` | **Supported** | Slot frozen. The hold's evidence is `replaced: [{"name":"read","expected":"builtin:read","actual":"<repo>/…/fixtures/reserved.ts"}]`. Launch stopped. |
| `agent-name`: a configured extension registers `agent_message` | **Supported** | Slot frozen. The hold's evidence is `extra: [{"name":"agent_message","source":"<repo>/…/fixtures/agent-name.ts"}]`. Launch stopped. |
| `cleared`: a station with `extensions: []` under a factory default extension | **Supported** | Its launch argv has no fixture extension and no `probe_named`. Its hello reports 4 tools and is accepted. The sibling station that inherits the default gets both. No hold. |

Every hold names the discrepant tool and attributes it to the source Pi reported. The cleared station gets neither the extension nor its tool. The "Done when" check passes on Linux, within the limits below. macOS is FOU-115's ([`rpc-53-3-macos.md`](rpc-53-3-macos.md)), which recorded it as inconclusive (platform unavailable). Nothing here is evidence for macOS.

## Versions and environment

- Pi coding agent `1.6.0`, the version pinned in `package-lock.json`, from the repository's own `node_modules`.
- Node `v22.23.2`, Linux `7.2.15-1-omarchy` (x86_64), 2026-11-25.
- Foundry at develop `c975ea0` (after FOU-36, FOU-115, FOU-122 and FOU-80) plus this ticket's evidence files, which change no product code. Built with `npm run build`. The final run's `versions.json` records the branch commit `f09cd1d`. `REGISTERED_AGENT_TOOLS` is `[]` at this commit.
- Model `probe-local/inert`: a `models.json` provider in the disposable agent dir, pointing at `http://127.0.0.1:9/v1` with a dummy key. No model call is made, because the Tool Set check runs on the worker's `hello` at session start. The testkit's faux provider was not used because an extension supplies it (`packages/testkit/src/pi/faux-provider.ts` calls `pi.registerProvider`). A station with `extensions: []` could not select it, and Pi exits when its `--model` does not resolve (checked by hand: `--model nope/none` gives `Error: Model "nope/none" not found`).

## Launcher

The launcher is the real chain from develop: `node packages/daemon/dist/main.js --home <root>/home <root>/factory.yaml` → the detached Worker Host → the pinned Pi `rpc-entry`, built by `buildLaunchCommand`. No `FOUNDRY_PI_BIN` override was used. The exact argv the host spawned for the `cleared/1` launch:

```
<node> <repo>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js
  --mode rpc --system-prompt "" --append-system-prompt ""
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve
  --session-id <conversation>
  --model probe-local/inert
  --tools read,bash,edit,write,agent_discover,agent_status,agent_message,agent_request,agent_reply,agent_delegate,task_transition,human_request
  --extension <repo>/packages/extension/dist/index.js
cwd: <root>/home/slots/probe/cleared-1
```

The other launches are identical apart from the session ID and cwd, except that they end in `,<named tool>` on `--tools` and one more `--extension <fixture>`:

| Launch | `--tools` tail | Extra `--extension` |
|---|---|---|
| `missing` `dev/1` | `…,probe_absent` | `fixtures/missing.ts` |
| `reserved` `dev/1` | `…,probe_named` | `fixtures/reserved.ts` |
| `agent-name` `dev/1` | `…,probe_named` | `fixtures/agent-name.ts` |
| `cleared` `inherit/1` | `…,probe_named` | `fixtures/named.ts` |
| `cleared` `cleared/1` | none | none |

Pi sets `process.title`, which blanks `/proc/<pid>/cmdline`. So the argv was recorded by `fixtures/record-argv.mjs`, a Node `--import` preload passed in `NODE_OPTIONS` to the probe's process tree. Only inside a Foundry launch, it writes `process.argv` and tees what the worker writes to `process.stderr` and `process.stdout` into the marker dir. It changes nothing about the launch. The tee is needed because the host keeps a launch's stderr only when the launch ends unexpectedly, and these launches end as requested.

## Isolation

Each variant runs in a new `mktemp -d` root holding its own `HOME`, `XDG_*`, `PI_CODING_AGENT_DIR` (with `settings.json` and `models.json`), Foundry state root (`--home`), and a local Git repository as `repository.source`. `FOUNDRY_HOME` points at an unused path. The environment holds only `PATH`, isolated Git variables (no global or system config), the variables above, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PROBE_MARKER_DIR` and `NODE_OPTIONS`. The driver stops each variant with `foundry shutdown --force` and removes its root, even when the variant fails. No operator `~/.pi`, `~/.foundry`, credential or network endpoint is used. After the final run, `pgrep` found no leftover probe process and no root was left in `/tmp`.

## Reproduction

Files in [`rpc-53-3-linux/`](rpc-53-3-linux/):

- `run-probe.mjs` is the driver. For each variant it writes the factory YAML, runs `foundry validate` on it, and starts the built daemon. It waits for every slot's `hello` outcome in `logs/daemon.log`, and for a refused one also waits for the launch to end. It then records `foundry hold list`, `hold show`, `slot list` and `slot show` through the built CLI, plus the fixture markers, and writes `<variant>.json` and `versions.json`.
- `fixtures/marker.ts` is shared by the fixture extensions. Each one registers its tools as no-ops, then records its load and, at `session_start`, Pi's own `getAllTools()` (with `sourceInfo.path`) and `getActiveTools()`.
- `fixtures/missing.ts` registers `probe_unnamed`. The YAML names `probe_absent`.
- `fixtures/reserved.ts` registers `probe_named` and `read`.
- `fixtures/agent-name.ts` registers `probe_named` and `agent_message`.
- `fixtures/named.ts` registers `probe_named`. It is the factory default in the `cleared` variant.
- `fixtures/record-argv.mjs` is the argv and output recorder described under Launcher.

```sh
npm ci && npm run build
node docs/evidence/rpc-53-3-linux/run-probe.mjs "$(mktemp -d)"
```

A run takes about 15 seconds. With no argument, the driver writes its output to a new `fou108-out-*` directory in the temp dir and leaves it there. Five runs during this work, on `bc83e3b` and after rebasing on `c975ea0`, gave the same outcomes. Only IDs, PIDs, timestamps and temp paths differed. Those outputs are not committed, and the observations below are from the last run.

### Effective fixtures

Every variant uses this production line, which the daemon's start checks require. Writing and final stages need a worktree station, and the final stage needs approval:

```yaml
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: s0
        station: eng.<first station>
        writing: true
      # cleared only: - id: s1, station: eng.cleared, writing: false
      - id: approve
        station: eng.<first station>
        approval: true
        on_rejection: s0
```

Stations (`version: 1`, `name: probe`, `repository.source: ./repo`):

```yaml
# missing / reserved / agent-name (one station each; extension file and tool name per variant)
      dev:
        isolation: worktree
        model: probe-local/inert
        extensions: [{ path: "<repo>/docs/evidence/rpc-53-3-linux/fixtures/missing.ts", tools: [probe_absent] }]
        #           reserved.ts / agent-name.ts with tools: [probe_named]

# cleared
defaults:
  extensions: [{ path: "<repo>/docs/evidence/rpc-53-3-linux/fixtures/named.ts", tools: [probe_named] }]
rooms:
  eng:
    stations:
      inherit:
        isolation: worktree
        model: probe-local/inert
      cleared:
        isolation: worktree
        model: probe-local/inert
        extensions: []
```

The driver records `foundry validate` in each `<variant>.json` (`validate`). It exits 0 for every variant. Its Tool Set listing shows the twelve fixed tools plus the named tool on its fixture path (13 tools), and for station `cleared` only the twelve fixed tools (`Tool Set for eng.cleared (12 tools)`).

## Observations (final run)

### `missing`

Daemon log: `channel hello refused {kind: terminal, code: tool_set_mismatch}`, then `launch ended dev/1`.

```
$ foundry hold show 1
kind        frozen_slot
subject     dev/1
factory     probe
state       open
evidence
  cause: tool_set_mismatch
  launchId: e2188925-…
  conversationRef: …
  missing: [{"name":"probe_absent","source":"<repo>/docs/evidence/rpc-53-3-linux/fixtures/missing.ts"}]
  extra: []
  replaced: []
commands
  foundry slot unfreeze dev/1
  foundry slot reset dev/1

$ foundry slot list
probe  dev/1  eng.dev  frozen (tool_set_mismatch)  launch e2188925-… ended (requested)
```

At session start, Pi's registry held only `read, bash, edit, write`. The fixture's unnamed `probe_unnamed` was registered by the extension, but Pi dropped it because `--tools` does not name it, so it is absent and not reported. `probe_absent` never existed. The launch ended with code 143 (SIGTERM from the host).

### `reserved`

Same log sequence. Hold evidence:

```
  missing: []
  extra: []
  replaced: [{"name":"read","expected":"builtin:read","actual":"<repo>/docs/evidence/rpc-53-3-linux/fixtures/reserved.ts"}]
```

At session start, Pi's registry attributed `read` to `fixtures/reserved.ts`, not `builtin:read`. Pinned Pi builds the registry from built-ins first, then sets each extension tool by name, so the last registration wins (`_refreshToolRegistry` in `dist/core/agent-session.js`). The worker's recorded stderr holds only two lines: Pi's `Warning: No project session found with id '…'; creating a new session with that id.`, which every launch in every variant prints because of `--session-id`, and the Foundry extension's `foundry: channel hello refused (terminal tool_set_mismatch)`. Pi printed no load error and no collision diagnostic on stderr. The stdout tee captured nothing, so it is no evidence either way. The collision is visible only through the source attribution, which the extension reports in `hello` and the daemon's check compares. The slot is frozen and the launch stopped (code 143).

### `agent-name`

Same log sequence. Hold evidence:

```
  missing: []
  extra: [{"name":"agent_message","source":"<repo>/docs/evidence/rpc-53-3-linux/fixtures/agent-name.ts"}]
  replaced: []
```

`agent_message` is on every launch's `--tools` list, so Pi activated the fixture's registration of it. It is reported as **extra** rather than **replaced** because this build's Foundry extension does not register the agent tools: `REGISTERED_AGENT_TOOLS` is `[]` (still so after FOU-36), so the check expects no `agent_message` at all. Once the extension registers them and `REGISTERED_AGENT_TOOLS` becomes `AGENT_TOOLS`, the same collision should show as `replaced` (expected the Foundry extension, actual the fixture). That prediction relies on load order: `buildLaunchCommand` passes the Foundry extension's `--extension` before every configured one, and the last registration of a name wins, so the fixture's tool is the one reported. If the order were reversed, the Foundry tool would win and the fixture's would be shadowed with no hold. Either way the slot is frozen here and the fixture's path is shown. The `replaced` form is not tested here.

### `cleared`

Daemon log: both hellos accepted, `cleared/1` with `{tools: 4}` and `inherit/1` with `{tools: 5}`; their order varies between runs. No hold.

```
$ foundry hold list
no open holds

$ foundry slot list
probe  inherit/1  eng.inherit  normal  launch e897291a-… live
probe  cleared/1  eng.cleared  normal  launch a9e26bb4-… live
```

- `cleared/1`: the launch argv (above) has only the Foundry extension, and `--tools` has no `probe_named`. `fixtures/named.ts` wrote no load or session marker for this slot, so it was never loaded. The hello reported the 4 built-ins, which is what the check expects, and it matched.
- `inherit/1`: the argv has `--extension fixtures/named.ts` and `…,probe_named`. The fixture loaded, and Pi's registry at session start held `probe_named` from `fixtures/named.ts`. The hello reported 5 tools and matched.

Both workers were live until `foundry shutdown --force` stopped them (`factory probe stopped (2 worker(s))`, `worker host stopped`).

## Findings that matter to Foundry

1. **Pi 1.6.0 does not refuse a tool-name collision. Foundry does.** An extension registering `read` or an agent tool name loads without error and silently takes the name over (last registration wins). Only the hello's source attribution exposes it, so the hello check is the sole defence. YAML validation already refuses naming a reserved tool, but it cannot see what an extension registers.
2. **Agent-name collisions are reported as `extra` while the Foundry extension registers no agent tools** (`REGISTERED_AGENT_TOOLS` is `[]`). The operator still sees the tool and its source. Anything that reads hold evidence should not assume that a collision always appears under `replaced`.
3. **A cleared station needs a model that no extension supplies.** With `extensions: []`, a provider extension such as the faux one is cleared too, and Pi exits on an unresolved `--model`. Running gates on the `cleared` shape needs a non-extension model source, as `models.json` was here.

## Limits of this evidence

- Linux only. macOS belongs to FOU-115, which recorded it as inconclusive.
- No model call, and no tool was called. The evidence shows what Pi registers and activates and what the daemon does with the hello. It does not show what a model can call. "A configured extension's named tool is callable" is a separate §17.2 bullet and is not covered here.
- Not tested: unfreezing these slots (the recheck relaunch, covered at a cheaper tier by FOU-138), two extensions registering the same non-reserved name, a reserved name registered after session start, MCP (`mcp__`) names, `codemode` or `tool_search`, and the `replaced` form of an agent-name collision once `REGISTERED_AGENT_TOOLS` is `AGENT_TOOLS`.
- The `NODE_OPTIONS` preload ran in every Node process of the probe, so the environment differs from production by that one variable. It only writes a file, and only inside launches.
