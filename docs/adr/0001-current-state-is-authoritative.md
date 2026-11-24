# Current state is authoritative; history is a log, not the source

Foundry is built around recovery, so a reader might expect its database to be event-sourced, with state rebuilt by replaying events. We decided the opposite: the current-state records are the authority, every change writes its history row in the same transaction, and nothing is ever rebuilt by replay. Reconciliation after a restart compares those records against what actually exists (Git, the Worker Host, a worker's conversation), which replay could not tell us anyway, and current-state rows let uniqueness constraints enforce the invariants directly.

Only the daemon process opens the database. The CLI and the Worker Host go through the daemon's API, and the Worker Host keeps its own small registry of launches. A single writer keeps every invariant inside one process's transactions; the cost is that nothing can be inspected or changed through Foundry while the daemon is down.

## Considered Options

- **Event sourcing**: rejected. The effects that matter in recovery live outside the database, so a replayed state would still have to be reconciled against the world, and projections would add a second thing to keep correct.
- **CLI reading the database directly**: rejected. It would tie the CLI to the schema and let it observe states the daemon has not finished reconciling.
- **Worker Host writing launch records**: rejected. The host stays the authority on which launch holds a slot and whether it is alive; the daemon's launch history is a copy refreshed at each reconciliation.
