# Real-model repository context: blocked

## Verdict and scope

**Blocked before worker launch; model behavior is unverified.** This is not a
supported result, an authentication failure, or evidence that injection fails.
No real-model worker was launched, no provider request was made, and no worker
transcript exists.

Source: [FOU-46](https://linear.app/foundry-mdl/issue/FOU-46/check-injected-repository-context-with-a-real-model),
PRD §17.3 (and repository-context contract §5.5).
Observed 2026-11-25 at 17:47 UTC on Linux. The issue remained In Progress.

The ticket requires the configured **Claude subscription provider**. The dispatch
requires **all agents to use Pi `openai/gpt-6.1-sol`**, explicitly prohibits silently
launching Claude, and directs this run to stop and document the model conflict.
A GPT worker would not prove the requested Claude behavior. A Claude worker would
violate the dispatch. An owner decision authorizing a Claude evidence worker is
needed before this check can run. No credentials were inspected or requested;
there was no secrets fallback, 1Password use, or production access.

## Versions and prerequisites

Inspected `origin/develop` after `git fetch origin develop` and
`git merge --ff-only origin/develop` (already up to date):
`e863ee27a382aad8aeca51099a9ab426c75ac5d0`.

| Component | Observation |
| --- | --- |
| Repository | `markdlabrecque/foundry`, branch `scheduled/fou-46-gpt61`, target `develop` |
| Node (`node --version`) | `v22.23.2` |
| npm (`npm --version`) | `10.9.8` |
| Operator Pi (`pi --version`) | `1.6.1`; not launched as an evidence worker |
| Foundry worker Pi | `1.6.0` pinned in `packages/host/package.json`; not executed in this check |
| Implementer | Pi `openai/gpt-6.1-sol`, confirmed by T3 capability response |
| Claude subscription | T3 catalog lists `pi-claude-subscription` models; authentication and runtime access were **not tested** |

Both recorded prerequisites were Done when re-read from Linear and are present in
`origin/develop`:

- [FOU-23](https://linear.app/foundry-mdl/issue/FOU-23): commit `9376022`;
  `packages/daemon/src/repository-context.ts` discovers root context and skill
  headers. `assignment-repository-context.ts` composes an ordinary context message,
  includes absolute skill paths, and deliberately excludes skill bodies.
- [FOU-95](https://linear.app/foundry-mdl/issue/FOU-95): commit `4a9d159`;
  `packages/host/src/launch-command.ts` supplies neutral slot cwd, session identity,
  explicit model and tools, the Foundry extension, and context suppression flags.

These source observations are not a substitute for a real-model result.

## Argv and transcript excerpt

Actual inspection argv included `pi --version`, `node --version`,
`npm --version`, `git fetch origin develop`, and
`git merge --ff-only origin/develop`. **Worker argv: none (not spawned).** No
fixture or disposable repository was created because the model-policy blocker was
identified before execution. Operator configuration and auth files were not read.

Sanitized control-plane transcript excerpt (not a worker transcript):

```text
Dispatch: All implementation and review agents MUST use Pi model
          openai/gpt-6.1-sol (GPT-6.1-Sol); do not substitute.
Dispatch: ... do not silently launch a Claude agent; stop and document the model
          requirement conflict if that evidence cannot be obtained without
          violating the workflow.
T3 capabilities: inheritedProviderInstanceId = pi
                 inheritedModel = openai/gpt-6.1-sol
Linear FOU-23: status = Done
Linear FOU-95: status = Done
$ pi --version
1.6.1
$ git merge --ff-only origin/develop
Already up to date.
```

## Acceptance and resumption

| Required observation | Status |
| --- | --- |
| Neutral worker obeys distinctive injected root directive | Unverified: worker not launched |
| Worker reads indexed skill body on demand | Unverified: no tool-call transcript |
| Configured Claude subscription works without secrets fallback | Unverified: access not attempted |

**Disposition: wait on the existing ticket for the owner's model-policy decision.**
Do not mark the behavioral acceptance criterion passed or close FOU-46 merely for
recording this blocker. [FOU-140](https://linear.app/foundry-mdl/issue/FOU-140),
the dependent P0 evidence ticket, must not treat this as a supported result.

Once authorized, resume FOU-46 against current `origin/develop`. Create only a
disposable repo and separate neutral worker directory. Give the repo a distinctive
root directive and an indexed skill whose body contains a separate observable
instruction. Inject the composed repository context with the skill header/path
only; do not leak the body into the assignment prompt. Use Foundry's launch builder
and pinned worker runtime, including `--no-context-files` and `--no-approve`.
Record the actual full argv, cwd, versions, configured subscription model, sanitized
injection and tool-call/response excerpts. A pass needs both directive obedience
and a read of the skill body followed by its required behavior. On access/provider
failure stop without fallback and record blocked; an ambiguous transcript is
inconclusive, never supported. Remove only the disposable resources created by
that run.
