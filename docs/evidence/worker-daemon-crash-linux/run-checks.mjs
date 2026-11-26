#!/usr/bin/env node
// Evidence-only regression invocation. No shared testkit/product change or global cache mutation.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, normalizeTree } from "./normalize.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(homedir(), "f124chk-"));
const temp = join(root, "t");
const piTemp = join(root, "p");
for (const dir of [temp, piTemp, join(root, "user")]) {mkdirSync(dir);}
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// Supported by testkit resolvePiBin / host resolvePiExecutable. The wrapper only restores TMPDIR
// dropped by startFauxPi's allowlist, then execs the unchanged pinned Pi CLI with ordered argv.
const wrapper = `#!/bin/sh\nexport TMPDIR=${quote(piTemp)}\nprintf '%s\\n' "$TMPDIR" >> ${quote(join(root, "wrapper-invocations.log"))}\nexec ${quote(process.execPath)} ${quote(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))} "$@"\n`;
const piBin = join(root, "pi");
writeFileSync(piBin, wrapper);
chmodSync(piBin, 0o700);
writeFileSync(join(out, "pi-wrapper.normalized.sh"), normalizeText(wrapper));
const env = { PATH: process.env.PATH ?? "", HOME: join(root, "user"), TMPDIR: temp, FOUNDRY_PI_BIN: piBin };
const status = { fullTicketAcceptance: false, environment: { ...env, PATH: "<REDACTED inherited PATH>" }, commands: [] };
try {
  for (const [label, command, args] of [
    ["build", "npm", ["run", "build"]],
    ["typecheck", "npm", ["run", "typecheck"]],
    ["oxlint", join(repo, "node_modules/.bin/oxlint"), []],
    ["unit-evidence", process.execPath, ["--test", "docs/evidence/worker-daemon-crash-linux/verdict.test.mjs"]],
    ["vitest", "npm", ["test"]],
    ["e2e", "npm", ["run", "test:e2e"]],
  ]) {
    const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    writeFileSync(join(out, `${label}.log`), normalizeText(output));
    status.commands.push({ label, command, args, ...exit });
    console.log(JSON.stringify({ label, ...exit }));
  }
} finally {
  // Only this run's exact private temp markers are eligible, never broad process-name matching.
  const marked = (pid) => {
    try {
      const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      return entries.includes(`TMPDIR=${temp}`) || entries.includes(`TMPDIR=${piTemp}`);
    } catch {return false;}
  };
  const processes = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map(Number).filter(marked);
  status.beforeCleanup = processes();
  for (let round = 0; round < 50 && processes().length; round++) {
    for (const pid of processes()) {try {if (marked(pid)) {process.kill(pid, "SIGKILL");}} catch { /* Process exited. */ }}
    await new Promise((done) => setTimeout(done, 100));
  }
  status.survivors = processes();
  const calls = existsSync(join(root, "wrapper-invocations.log")) ? readFileSync(join(root, "wrapper-invocations.log"), "utf8").trim().split("\n") : [];
  status.wrapper = { invocations: calls.length, privateTmpdirVerified: calls.length > 0 && calls.every((line) => line === piTemp) };
  if (!status.survivors.length) {rmSync(root, { recursive: true, force: true });}
  status.rootRemoved = !existsSync(root);
  writeFileSync(join(out, "status.json"), normalizeText(`${JSON.stringify(status, null, 2)}\n`));
  normalizeTree(out);
  process.exitCode = status.commands.length === 6 && status.commands.every((c) => c.code === 0) && status.wrapper.privateTmpdirVerified && status.rootRemoved ? 0 : 1;
}
