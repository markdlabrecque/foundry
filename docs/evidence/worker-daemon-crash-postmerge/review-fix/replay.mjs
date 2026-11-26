// Read-only evidence replay; no processes, live DB, worker actions or mutation of artifacts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { continuationChecks, verdict } from '../verify.mjs';
const evidence = resolve(fileURLToPath(new URL('../', import.meta.url)));
const input = resolve(process.argv[2] ?? `${evidence}/run`);
const result = JSON.parse(readFileSync(`${input}/result.json`, 'utf8'));
const proof = JSON.parse(readFileSync(`${input}/continuation-evidence.json`, 'utf8'));
const checks = continuationChecks(proof);
assert.equal(Object.keys(checks).length, 9);
assert.ok(Object.values(checks).every((v) => v === true));
for (const [key, value] of Object.entries(checks)) { assert.equal(result.checks[key], value); }
assert.equal(verdict({ ...result.checks, ...checks }, result.journeyCompleted).exitCode, 0);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const pins = result.events.find((e) => e.event === 'versions').detail.evidenceSourceSha256;
const sources = {};
for (const [file, hash] of Object.entries(pins)) {
  const current = resolve(evidence, '..', file);
  const source = sha(current) === hash ? current : file === 'worker-daemon-crash-postmerge/verify.mjs' ? `${evidence}/review-fix/before-review/verify.mjs` : current;
  assert.equal(sha(source), hash); sources[file] = { sha256: hash, archivedBeforeReview: source !== current };
}
console.log(JSON.stringify({ capturedCheckoutHead: result.productionBase, replayOracleSha256: sha(`${evidence}/verify.mjs`), continuationChecks: checks, verdict: verdict({ ...result.checks, ...checks }, result.journeyCompleted), capturedRuntimeSources: sources }, null, 2));
