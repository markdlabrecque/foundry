#!/usr/bin/env node
// FOU-155 manual Linux wiring probe. Reuse the RPC sibling's fixture, sampling,
// ownership-marker cleanup and assertions; only the selected Worker Host runtime differs.
// Usage after npm ci && npm run build:
//   node docs/evidence/sdk-54-4-linux/run-probe.mjs <output-directory>
// This is not a commit-tier automated test. No operator config or real model is used.
process.argv[3] = "sdk";
await import("../rpc-54-4-linux/run-probe.mjs");
