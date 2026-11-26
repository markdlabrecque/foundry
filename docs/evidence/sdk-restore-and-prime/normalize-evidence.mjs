// Presentation only: preserve package/executable identity, argv order, source
// relations and IDs; replace machine-specific prefixes even inside JSONL strings.
import { dirname } from 'node:path';
import { homedir } from 'node:os';
export function normalizeEvidence(text, { repo, fixture, privateTmp, node, userHome = homedir() }) {
  const replacements = [[repo, '<repo>'], [fixture, '<fixture>'], [node, '<node>'], [node && dirname(node), '<node-bin>'], [privateTmp, '<private-tmp>'], [userHome, '<home>']]
    .filter(([prefix]) => prefix && prefix !== '/').sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, placeholder] of replacements) text = text.split(prefix).join(placeholder);
  return text;
}
