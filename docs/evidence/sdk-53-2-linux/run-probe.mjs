#!/usr/bin/env node
// Manual real-process evidence only; reuse the RPC sibling's calibrated controls.
// npm run build && node docs/evidence/sdk-53-2-linux/run-probe.mjs <output-dir>
process.env.FOUNDRY_PROBE_RUNTIME = 'sdk';
await import('../rpc-53-2-linux/run-probe.mjs');
