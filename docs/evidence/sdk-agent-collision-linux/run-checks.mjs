// Final regression runner: ordinary pinned Pi, shared testkit TMPDIR fix now merged.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const out = resolve("docs/evidence/sdk-agent-collision-linux/checks");
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(homedir(), "f163c-"));
const tmp = join(root, "t");
mkdirSync(tmp);
const env = {...process.env, TMPDIR: tmp};
delete env.FOUNDRY_PI_BIN;
const commands = [
  ["build", "npm", ["run", "build"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["oxlint", "./node_modules/.bin/oxlint", []],
  ["vitest", "./node_modules/.bin/vitest", ["run"]],
  ["e2e", "npm", ["run", "test:e2e"]],
];
const status = [];
try {
  for (const [name, command, args] of commands) {
    const result = spawnSync(command, args, {env, encoding: "utf8", timeout: 180_000});
    writeFileSync(join(out, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd() + "\n");
    status.push({name, command, args, exit: result.status, signal: result.signal, error: result.error?.message});
    console.log(`${name}: exit ${result.status}`);
  }
  writeFileSync(join(out, "status.json"), JSON.stringify({tmp, node: process.execPath, childTmpdir: "shared testkit propagation; no FOUNDRY_PI_BIN override", commands: status}, null, 2) + "\n");
} finally { rmSync(root, {recursive: true, force: true}); }
if (status.some(s => s.exit !== 0)) process.exitCode = 1;
