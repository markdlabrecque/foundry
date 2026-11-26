#!/usr/bin/env node
// Evidence-only path transformation. Private source capture stays outside Git.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const r = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const checkout = r.ordinaryCommand[1].split('/node_modules/')[0];
const nodeRoot = dirname(dirname(r.ordinaryCommand[0]));
// Longest prefixes first, including the nested run root. No semantic observations
// (IDs, counts, marker strings, argv ordering or tool results) are changed.
const mappings = [[r.root, '/RUN'], [checkout, '/REPO'], [nodeRoot, '/NODE']].sort((a,b) => b[0].length - a[0].length);
if (r.environment?.PATH) r.environment.PATH = '<ALLOWLISTED_PATH_OMITTED>';
let text = JSON.stringify(r);
for (const [from, to] of mappings) text = text.replaceAll(from, to);
const result = JSON.parse(text);
result.artifactTransform = 'Path-normalized capture: /RUN = disposable root, /REPO = source checkout, /NODE = pinned Node installation. Only PATH search-list text omitted; argv/source/cwd relationships preserved. Not byte-for-byte raw output.';
writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
