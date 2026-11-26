// Normalize only retained artifacts, never executable drivers/fixtures. Idempotent.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
const here = resolve("docs/evidence/sdk-agent-collision-linux");
const statusPath = join(here, "checks/status.json");
const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : {};
const substitutions = [
  [process.execPath, "<NODE>"], [process.cwd(), "<REPO>"],
  ...(status.tmp?.startsWith("/") ? [[dirname(status.tmp), "<CHECK_ROOT>"]] : []),
  [join(homedir(), "f163"), "<PROBE_TMP>"], [homedir(), "<HOME>"], ["/tmp/", "<SYSTEM_TMP>/"],
];
for (const folder of ["results", "checks"]) {
  for (const file of readdirSync(join(here, folder))) {
    if (!/\.(json|log|txt)$/.test(file)) continue;
    const path = join(here, folder, file);
    let text = readFileSync(path, "utf8");
    for (const [from, to] of substitutions) text = text.replaceAll(from, to);
    if (file === "vitest.log") text = text.split("\n").filter(line => !/^\s*[✓✔].*\.test\./.test(line)).join("\n");
    writeFileSync(path, text.trimEnd() + (text.trimEnd() ? "\n" : ""));
  }
}
