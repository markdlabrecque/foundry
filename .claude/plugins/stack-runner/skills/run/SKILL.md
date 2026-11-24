---
name: run
description: Work through a stack of Linear tickets with parallel implementer subagents, review loops, local tests, merge into the current branch, and Linear closing. Use when given a goal like "finish these tickets".
argument-hint: <goal, ticket ids, project, or label>
disable-model-invocation: true
---

You are the orchestrator. Goal: $ARGUMENTS

You coordinate. You do not implement or review code yourself. Subagents: `stack-runner:implementer`, `stack-runner:reviewer`.

## 0. Preflight
- Integration branch = the branch you are on now. Record it. Working tree must be clean; if not, stop and tell the user.
- Find the test command (CLAUDE.md, package.json, Makefile). If unclear, ask once.
- Find Linear tools with ToolSearch ("linear"). If not authenticated, stop and tell the user.
- Never push. Never touch remotes. All merges are local.

## 1. Build the graph
- Fetch the tickets that match the goal from Linear. For each: id, title, description, state, and its "blocked by" relations.
- Ignore tickets already Done/Canceled. A blocker outside the set that is not Done blocks its dependents: report it and hold them.
- A ticket is **ready** when all blockers are Done.
- Show the user one short table: ticket, blocked by, ready?. Then start. Do not wait for approval unless the graph has a cycle or the goal is ambiguous.

## 2. Dispatch
- No concurrency limit. Start every ready ticket at once.
- Spawn each implementer with `isolation: "worktree"`, in the background, all in one message when starting several. Prompt: full ticket text, integration branch name, test command, and "follow your agent instructions".
- Track per ticket: state, implementer agent id, branch, worktree, fix round.

## 3. Per ticket pipeline
When an implementer finishes:

1. **Review.** Spawn a fresh `stack-runner:reviewer` (never the implementer). Give ticket text, branch, worktree, integration branch.
2. **MUST-FIX?** Send the M-list to the *same implementer* with SendMessage (it keeps its context and worktree). When it reports back, send the reviewer the original M-list plus the new diff for a **re-review**: only the original items, plus `NEW` only if the fix broke something serious. Repeat.
3. **Cap:** 2 fix rounds. Still MUST-FIX after that: mark the ticket **stuck**, leave it open in Linear, comment the findings on the ticket, move on. Do not block other work.
4. **PASS → test.** In the ticket's worktree: merge the integration branch into the ticket branch (`git merge <integration>`), then run the test command yourself. Merge conflict or test failure: send the details to the same implementer to fix, then test again. Counts toward the same 2-round cap. No re-review for conflict/test fixes unless the change is more than a mechanical resolution.
5. **Merge.** From the integration worktree: `git merge --ff-only <ticket-branch>`; if the integration branch moved meanwhile, repeat step 4. Merge one ticket at a time.
6. **Close in Linear.** Set state Done. Add a comment: branch, merge commit sha.
7. **Unblock.** Re-check blockers of every open ticket. Newly ready ones go to step 2 of section 2 right away.
8. **Clean up.** Remove the merged worktree and delete its branch.

## 4. Finish
When nothing is in flight and nothing is ready, print:
- Merged (ticket → sha)
- Stuck (ticket → why)
- Held (ticket → open blocker)
- Integration branch tip and test result on it (run the full suite once).

## Rules
- Keep your own context small: ask subagents for summaries, not diffs.
- Anything surprising (cycle, missing ticket, an implementer asking a question): surface it to the user instead of guessing.
- Never mark a ticket Done before it is merged.
