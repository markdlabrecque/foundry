#!/usr/bin/env node
// Manual evidence recheck; reuse both unchanged verdicts. Never load fixture Git hooks.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evidence = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawPath = resolve(evidence, 'rpc-54-4-linux/run-probe.mjs');
const sdkPath = resolve(evidence, 'sdk-54-4-linux/run-probe.mjs');
const rawTemp = resolve(dirname(rawPath), `fou145-${process.pid}.mjs`);
const sdkTemp = resolve(dirname(sdkPath), `fou145-${process.pid}.mjs`);
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'source splice must match exactly once');
  return source.replace(before, after);
};
const raw = replaceOnce(readFileSync(rawPath, 'utf8'),
  'git(source, ["commit", "--quiet", "--no-verify", "-m", "fixture"]);',
  'git(source, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-verify", "-m", "fixture"]);');
const sdk = replaceOnce(readFileSync(sdkPath, 'utf8'),
  'await import("../rpc-54-4-linux/run-probe.mjs");',
  `await import(${JSON.stringify(pathToFileURL(rawTemp).href)});`);
let rawCreated = false;
let sdkCreated = false;
try {
  writeFileSync(rawTemp, raw, { flag: 'wx', mode: 0o600 });
  rawCreated = true;
  writeFileSync(sdkTemp, sdk, { flag: 'wx', mode: 0o600 });
  sdkCreated = true;
  await import(pathToFileURL(sdkTemp).href);
} finally {
  if (sdkCreated) unlinkSync(sdkTemp);
  if (rawCreated) unlinkSync(rawTemp);
}
