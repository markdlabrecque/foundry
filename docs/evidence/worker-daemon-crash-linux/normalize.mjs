// Evidence copies only: never use tokenized strings as executable paths or runtime inputs.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeText(text) {
  return text
    .replace(/"PATH"\s*:\s*"(?:\\.|[^"\\])*"/g, '"PATH":"<REDACTED inherited PATH>"')
    .replace(/\/(?:home|Users)\/[^\s"\\]*?\/worktress\/develop\/t3-[a-f0-9]+-[a-f0-9]+/g, "<CHECKOUT>")
    .replaceAll(homedir(), "<USER_HOME>");
}

export function normalizeTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {normalizeTree(path);}
    else if (entry.isFile() && !/^foundry\.db(?:-|$)/.test(entry.name)) {
      writeFileSync(path, normalizeText(readFileSync(path, "utf8")));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dir of process.argv.slice(2)) {normalizeTree(dir);}
}
