// Regression environment accommodation only; no product, testkit or test changes.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const out = resolve("docs/evidence/sdk-53-3-linux/checks");
mkdirSync(out, { recursive: true });
// Short private home-backed path keeps Unix socket names under the platform limit.
const root = mkdtempSync(join(homedir(), "f153c-"));
const tmp = join(root, "t");
mkdirSync(tmp);
const shim = join(root, "pi");
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const script = `#!/bin/sh\n# Only restore private TMPDIR in Pi children whose testkit env drops it.\nexport TMPDIR=${quote(tmp)}\nexec ${quote(process.execPath)} ${quote(resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))} "$@"\n`;
writeFileSync(shim, script);
chmodSync(shim, 0o700);
writeFileSync(join(out, "launch-shim.txt"), script);
const commands = [
  ["build", "npm", ["run", "build"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["oxlint", "./node_modules/.bin/oxlint", []],
  ["vitest", "./node_modules/.bin/vitest", ["run"]],
  ["e2e", "./node_modules/.bin/vitest", ["run", "--config", "vitest.e2e.config.ts"]],
];
const status = [];
try {
  for (const [name, command, args] of commands) {
    const result = spawnSync(command, args, {env: {...process.env, TMPDIR: tmp, FOUNDRY_PI_BIN: shim}, encoding: "utf8", timeout: 180_000});
    writeFileSync(join(out, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd() + "\n");
    status.push({name, command, args, exit: result.status, signal: result.signal, error: result.error?.message});
    console.log(`${name}: exit ${result.status}`);
  }
  writeFileSync(join(out, "status.json"), JSON.stringify({tmp, shim, node: process.execPath, commands: status}, null, 2) + "\n");
} finally { rmSync(root, {recursive: true, force: true}); }
if (status.some(s => s.exit !== 0)) process.exitCode = 1;
