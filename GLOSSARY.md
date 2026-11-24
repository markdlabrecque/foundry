# Foundry

Foundry orchestrates persistent teams of Pi agents that plan, implement, review, test and integrate software on a single host.

## Language

### Organization

**Instance**:
One running Foundry: a daemon, a worker host and the factories they serve.
_Avoid_: Installation, server, deployment

**State Root**:
The directory holding everything an instance keeps on disk.
_Avoid_: Home, data directory, workspace

**Factory**:
An independently managed development organization, bound to one repository.
_Avoid_: Rig, team, project

**Room**:
A logical grouping of stations that share responsibilities, policies or knowledge. It is not a shared conversation.
_Avoid_: Pod, group, channel

**Station**:
A persistent, named agent role within a factory, with a stable identifier that outlives any worker.
_Avoid_: Seat, position, role, agent

**Worker**:
A running agent instance occupying a station.
_Avoid_: Agent, session, process

**Slot**:
One of a station's fixed worker positions, which outlives the worker occupying it.
_Avoid_: Instance, seat

**Worker Host**:
The Foundry component that owns worker lifetimes and knows which launches occupy which slots.
_Avoid_: Daemon, Pi runtime

**Host Reference**:
An opaque handle issued by a worker host for one worker launch, not for the slot that launch occupies.
_Avoid_: PID, slot ID, session ID

**Launch**:
One start of a worker in a slot, identified by the worker host.
_Avoid_: Spawn, run, PID

**Conversation**:
A worker's recoverable history in a slot, which outlives a launch and ends when the slot is reset.
_Avoid_: Session, thread, context

**Channel**:
The connection a worker opens to the daemon for messages, state and tool calls.
_Avoid_: Socket, control channel, stdio

**Priming**:
The daemon's single step that composes a worker's starting context and sends it to the worker.
_Avoid_: Bootstrap, onboarding, system prompt

**Situation**:
The circumstance a priming answers: fresh start, recovery or compaction.
_Avoid_: Mode, reason, start type

**Repository Context**:
The instructions and skill index a repository would give an agent launched inside it.
_Avoid_: Project context, context files, ambient instructions

**Tool Set**:
The tools a worker is offered: the fixed tools every worker has plus those named on its station's configured extensions.
_Avoid_: Pinned set, allowlist, loadout

**Knowledge Root**:
A factory's reserved directory tree holding the knowledge of the factory, its rooms and its stations.
_Avoid_: Memory directory, workspace

**Operator**:
The human who runs factories and makes the decisions reserved for a person.
_Avoid_: User, admin, developer

### Work

**Ticket**:
An individual unit of work, and the primary unit of execution.
_Avoid_: Task, issue, job

**Work Package**:
An independently implementable and verifiable deliverable made of one or more tickets.
_Avoid_: Slice, epic, story

**Initiative**:
A larger development objective that groups work packages, potentially with its own integration branch.
_Avoid_: Mission, project, epic

**Backlog**:
Work that has been submitted and is waiting to enter a production line.
_Avoid_: Queue, inbox

**Production Line**:
A configured workflow of stages through which a ticket progresses.
_Avoid_: Workflow, pipeline

**Evidence**:
Artifacts demonstrating that a ticket's requirements have been satisfied, tied to the revision evaluated.
_Avoid_: Proof, results, logs

**Stage**:
A step of a production line, served by one station.
_Avoid_: Step, phase, state

**Assignment**:
The binding of a ticket at a stage to one slot.
_Avoid_: Claim, ownership

**Outcome**:
What a worker reports for its assignment: done, rejected or blocked. A worker reports an outcome; the factory records a transition.
_Avoid_: Result, verdict

**Transition**:
The record of one change to a ticket's stage or status, whoever caused it.
_Avoid_: Outcome, event, state change

**Delegation**:
A tracked work obligation one station asks another to fulfill within an existing ticket. It is neither a new ticket nor the notification that carries the request.
_Avoid_: Child ticket, assignment

**Message**:
A communication Foundry routes to a worker. Retrying delivery does not create a new message.
_Avoid_: Offer

**Acknowledgement**:
Foundry's record that a message is in a worker's recoverable conversation history. Until Foundry records the worker's receipt, the message is unacknowledged; acknowledgement says nothing about whether the worker answered or did the work.
_Avoid_: Receipt, delivery, read

**Approval**:
An operator decision the factory is waiting on, either gating a stage or answering a worker's request.
_Avoid_: Sign-off, decision, gate

**Writing Stage**:
A stage whose worker may change the ticket's branch.
_Avoid_: Code stage, build stage

**Integration**:
The merge of a ticket's approved commit into the default branch, performed by the factory itself rather than by a worker.
_Avoid_: Merge, landing, release

**Ticket Directory**:
The per-ticket location outside the repository that holds its specification and evidence.
_Avoid_: Artifact folder, ticket worktree

### Recovery

**Reconciliation**:
Comparing Foundry's records against what actually exists before resuming.
_Avoid_: Recovery, sync

**Indeterminate**:
Said of an effect whose completion Foundry cannot establish from its own evidence.
_Avoid_: Unknown, failed

**Frozen**:
Said of a slot the daemon will not send to or launch into until the operator resolves it.
_Avoid_: Locked, quarantined

**Parked**:
Said of a slot taken out of use after its recovery limit was reached.
_Avoid_: Frozen, disabled

**Resume Notice**:
The daemon's message telling a worker its assignment was interrupted and what Foundry holds on record.
_Avoid_: Recovery prime, wake-up

**Operator Hold**:
Something waiting on the operator that concerns the system's state, not a decision about work. It is not an approval.
_Avoid_: Attention item, alert, incident

### Repository

**Factory Clone**:
The copy of a repository that a factory alone works in, created from a configured source.
_Avoid_: Repo, checkout, working copy

**Operation**:
A repository action the factory performs itself: integration, source sync, worktree creation, hook run or cleanup.
_Avoid_: Job, task, command
