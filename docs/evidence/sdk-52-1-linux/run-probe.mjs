#!/usr/bin/env node
// FOU-149: manual SDK/Linux gate, not a commit-suite test.
// Reuse the RPC sibling's actual daemon/host wiring, disposable busy faux provider,
// channel observations, bounded reconnect window and marker-restricted cleanup.
// No operator environment is forwarded by that driver except PATH and this selector.
process.env.FOUNDRY_WORKER_RUNTIME = "sdk";
await import("../rpc-52-1-linux/run-probe.mjs");
