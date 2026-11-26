// Fixture-only guard: fake builtin auth may pass preflight, never a real request.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const record = kind => appendFileSync(join(process.env.PROBE_MARKER_DIR, 'network.jsonl'), JSON.stringify({ kind, pid: process.pid, slot: process.env.FOUNDRY_SLOT ?? 'ordinary' }) + '\n');
record('deny-fetch-installed');
globalThis.fetch = () => {
  record('fetch-denied');
  throw new Error('FOU-151 fixture forbids fetch; no real provider request permitted');
};
