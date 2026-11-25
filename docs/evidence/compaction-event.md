# Evidence: compaction events in pinned Pi 1.6.0

Ticket: FOU-28 (build plan ticket 37). Product contract: PRD §5.5 (compaction prime) and §17.3 ("That Pi's compaction event fires for automatic and mid-run compaction").

## Outcome

| Mode | Outcome | Event | Boundary observed |
|---|---|---|---|
| Configured automatic compaction (threshold, after a run) | **Supported** | `session_compact` with `reason: "threshold"`, `willRetry: false` | After `agent_end`, before `agent_settled`, once the run has finished |
| Mid-run compaction (threshold, between tool rounds) | **Supported** | `session_compact` with `reason: "threshold"`, `willRetry: false` | After a tool round's `turn_end` (`stopReason: "toolUse"`), before the next `turn_start` of the same run |

In both modes `session_before_compact` came first, then the summary model call, then `session_compact`, all inside one `compaction_start` / `compaction_end` pair on the RPC stream. In both modes `ctx.isIdle()` was `false` when the event fired.

The result is positive for both modes, so it meets ticket 38a's "positive evidence required" input. It holds only within the limits below. **A negative or inconclusive result would not have unblocked production compaction. The same goes for any mode or path listed under "Not tested": no Foundry behaviour may rely on it until it has its own evidence.**

## Versions and environment

- Pi coding agent `1.6.0` (`pi --version`), with `@earendil-works/pi-ai` `1.6.0`, run as `node <release>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.
- Node `v22.23.2`, Linux (Omarchy, kernel 7.2.15), 2026-11-24/25.
- Model: pi-ai's built-in faux provider (`fauxProvider`), registered by the probe extension as `probe/tiny` with `contextWindow: 8000` and `maxTokens: 1024`. No network, no credentials and no real model.
- Settings, written to the isolated agent dir's `settings.json`:
  `{"enableInstallTelemetry": false, "compaction": {"enabled": true, "reserveTokens": 2000, "keepRecentTokens": 1000}}`.
  Threshold: `contextTokens > 8000 - 2000 = 6000`.

## Isolation

Each scenario runs in a new `mktemp -d` root with its own `HOME`, `XDG_*`, `PI_CODING_AGENT_DIR`, session dir and working dir. The child environment holds only `PATH` and those variables, plus `PI_OFFLINE=1` and `PI_TELEMETRY=0`. Pi is launched with:

```
--mode rpc --no-extensions --extension probe-extension.ts
--provider probe --model tiny --tools pad
--no-context-files --no-skills --no-prompt-templates --no-themes
--no-approve --offline --session-dir <tmp>/sessions
```

The probe does not read or change the operator's `~/.pi`, sessions or credentials.

## Reproduction

Files in [`compaction-event/`](compaction-event/):

- `probe-extension.ts` registers the faux model, a `pad` tool (returns `size` characters of filler) and a logger that writes every lifecycle and compaction event to `$PROBE_LOG` as JSONL. The prompt scripts the model: `ROUNDS <n>` makes it call `pad` n times and then answer `done`, and `SIZE <n>` sets the size of each result. It answers Pi's summarization request (recognised by its system prompt) with a fixed summary.
- `run-probe.mjs` is the RPC driver. It sends each prompt, waits for `agent_settled`, then calls `get_entries`, and writes `<scenario>.extension.jsonl`, `<scenario>.rpc.jsonl`, `<scenario>.entries.json` and `summary.json`.

```sh
cd docs/evidence/compaction-event
node run-probe.mjs "$(mktemp -d)"     # optional: PI_BIN=/path/to/pi-coding-agent/dist/cli.js
```

It takes a few seconds. Two runs from scratch gave identical `summary.json` results (diffed). Only timestamps, IDs and temp paths differ.

### Scenarios

| Scenario | Prompts | Purpose |
|---|---|---|
| `auto_single_span` | one text-only prompt of ~6.3k tokens | Negative control (see below) |
| `auto` | two text-only prompts (~3k, then ~3.5k tokens) | Configured automatic compaction after a run |
| `midrun` | one prompt, `ROUNDS 4 SIZE 10000` (~2.5k tokens per tool result) | Compaction between tool rounds of one run |

## Observations

Extension event order (`summary.json`, `[summary-call]` = the faux model receiving Pi's summarization request):

```
auto_single_span (0 compactions)
  input > before_agent_start > agent_start > turn_start > turn_end(stop) > agent_end > agent_settled

auto (1 compaction, reason threshold)
  input > before_agent_start > agent_start > turn_start > turn_end(stop) > agent_end > agent_settled
  > input > before_agent_start > agent_start > turn_start > turn_end(stop) > agent_end
  > session_before_compact(threshold)[busy] > [summary-call] > session_compact(threshold)[busy]
  > agent_settled

midrun (1 compaction, reason threshold)
  input > before_agent_start > agent_start
  > turn_start > tool_execution_start > tool_execution_end > turn_end(toolUse)
  > turn_start > tool_execution_start > tool_execution_end > turn_end(toolUse)
  > turn_start > tool_execution_start > tool_execution_end > turn_end(toolUse)
  > session_before_compact(threshold)[busy] > [summary-call] > session_compact(threshold)[busy]
  > turn_start > tool_execution_start > tool_execution_end > turn_end(toolUse)
  > turn_start > turn_end(stop) > agent_end > agent_settled
```

`[busy]` means `ctx.isIdle()` returned `false` inside the handler.

### `session_compact` payloads

The probe redacts IDs, timestamps and the summary text, and replaces `systemMessage` and `toolsAdded` with flags because they contain machine paths.

`auto`:

```json
{"type":"session_compact","reason":"threshold","willRetry":false,"fromExtension":false,
 "compactionEntry":{"type":"compaction","id":"<id>","parentId":"<id>","timestamp":"<ts>",
  "firstKeptEntryId":"<id>","tokensBefore":6966,"details":{"readFiles":[],"modifiedFiles":[]},
  "usage":{"input":3318,"output":15,"cacheRead":0,"cacheWrite":0,"totalTokens":3333,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "fromHook":false,"hasSystemMessage":true,"toolsAddedCount":0,"summaryChars":58},"idle":false}
```

`midrun` (`session_before_compact` reported `isSplitTurn: true`: the cut fell inside the single user-message span):

```json
{"type":"session_compact","reason":"threshold","willRetry":false,"fromExtension":false,
 "compactionEntry":{"type":"compaction","id":"<id>","parentId":"<id>","timestamp":"<ts>",
  "firstKeptEntryId":"<id>","tokensBefore":7989,"details":{"readFiles":[],"modifiedFiles":[]},
  "usage":{"input":1310,"output":15,"cacheRead":0,"cacheWrite":0,"totalTokens":1325,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "fromHook":false,"hasSystemMessage":true,"toolsAddedCount":0,"summaryChars":114},"idle":false}
```

### RPC stream (same runs)

```
auto:   ... agent_end > compaction_start{reason:threshold}
        > compaction_end{reason:threshold, aborted:false, willRetry:false,
                         result:{tokensBefore:6966, estimatedTokensAfter:3967}} > agent_settled
midrun: ... turn_end(toolUse) > compaction_start{reason:threshold}
        > compaction_end{..., result:{tokensBefore:7989, estimatedTokensAfter:2983}}
        > turn_start ... agent_end > agent_settled
```

Session entries after `midrun`: `... message:toolResult, compaction, message:assistant, message:toolResult, message:assistant`. The compaction entry is written into the session between tool rounds, and the run continues in the same conversation and process.

### Where Pi 1.6.0 fires these, from source

These match `dist/core/agent-session.js`. Every automatic path goes through `_runAutoCompaction(reason, willRetry)`, which emits `session_before_compact` → `session_compact` (or `session_compact_failed`):

- Mid-run: `_installAgentNextTurnRefresh` → `_compactBeforeNextAssistantResponse` (the agent's `prepareNextTurn` hook, after tool results are appended and before `turn_start`). **Observed** (`midrun`).
- After a run: `_checkCompaction(lastAssistant)` in the post-run loop, after `agent_end` and before settling. **Observed** (`auto`).
- Before a new prompt: `_prepareRun` → `_checkCompaction(lastAssistant, false)`, before `before_agent_start`. **Not observed**, because the post-run check had already compacted.
- Virtual-model request routing: `_installAgentRequestProjection` → threshold check in `prepareRequest`. **Not tested.**
- Overflow recovery (`reason: "overflow"`, possibly `willRetry: true`). **Not tested.**

## Findings that matter to Foundry

1. **Crossing the threshold does not guarantee an event.** In `auto_single_span` the context (6708 tokens) crossed the 6000 threshold, but the session held a single user-message span. `prepareCompaction` found nothing to summarize and returned `undefined`, so Pi skipped compaction silently. There was no `compaction_start`, no `session_before_compact`, no `session_compact` and no `session_compact_failed`. The extension cannot treat "over the threshold" as "compacted". Only `session_compact` means a compaction happened.
2. **Both events fire while Pi is busy** (`ctx.isIdle() === false`). After a run, the event comes between `agent_end` and `agent_settled`, so an extension that waits for `agent_settled` sees the compaction first. During a run, the event comes at a tool-round boundary, matching the PRD §5.5 assumption that the prime is injected "at the next tool-round boundary". This probe did not test whether a message steered in from a `session_compact` handler is delivered before the next `turn_start` (Pi's docs mention a catch-up steering poll after compaction). That belongs to ticket 38b.
3. **`reason` and `willRetry` tell the trigger apart.** Both observed cases were `reason: "threshold"`, `willRetry: false`. Manual `/compact` reports `"manual"`, and overflow recovery reports `"overflow"`.

## Limits of this evidence

- Only a faux model was used. Which events fire and in what order depends on Pi's session code, not the provider, but token counts come from the faux provider's character-based usage estimate, not a real tokenizer.
- The context window was set very small (8000 tokens, 2000 reserve, 1000 kept) to force compaction. Production defaults (16384 reserve, 20000 kept) were not exercised.
- Linux only. Not tested on macOS.
- Not tested: `reason: "overflow"` (provider overflow or a `length` stop with retry), manual `/compact` (RPC `compact`), the pre-prompt check in `_prepareRun`, virtual-model routing, failed or cancelled compaction (`session_compact_failed`), repeated compactions in one session, and compaction while the extension's daemon channel is down (the reconnect case in ticket 38a). None of these is supported by this evidence.
- Interactive (TUI) mode was not run. Only RPC mode was used, which is the mode Foundry workers use.
