// Record exact merged product/tree and source hashes; never imply that uncommitted
// evidence files were part of the product revision tested.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const here = "docs/evidence/sdk-53-3-linux-acceptance";
const git = (...args) => execFileSync("git", args, {encoding: "utf8"}).trim();
const changedProduct = git("diff", "--name-only", "1bde222^", "1bde222", "--", "packages").split("\n").filter(Boolean);
const files = new Set([
  ...changedProduct, "package-lock.json", "packages/host/src/control.ts",
  "docs/evidence/rpc-53-3-linux/run-probe.mjs",
  ...readdirSync("docs/evidence/rpc-53-3-linux/fixtures").map(f => `docs/evidence/rpc-53-3-linux/fixtures/${f}`),
  "docs/evidence/sdk-53-3-linux/record-process.mjs", "docs/evidence/sdk-53-3-linux/inspect-load.mjs",
  ...["run-probe.mjs", "check-observations.mjs", "run-checks.mjs", "normalize-evidence.mjs"].map(f => `docs/evidence/sdk-agent-collision-linux/${f}`),
  ...readdirSync(here).filter(f => f.endsWith(".mjs")).map(f => `${here}/${f}`),
]);
const sourceSha256 = Object.fromEntries([...files].sort().map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const productDiff = git("diff", "HEAD", "--", "packages", "test", "package-lock.json", "package.json");
if (productDiff) throw new Error("Product/test/config changed during acceptance");
writeFileSync(`${here}/results/source-provenance.json`, JSON.stringify({
  productCommit: git("rev-parse", "HEAD"), productTree: git("rev-parse", "HEAD^{tree}"),
  mergedRemediation: git("rev-parse", "1bde222"), node: process.version,
  npm: execFileSync("npm", ["--version"], {encoding: "utf8"}).trim(),
  productDiff, observationTime: new Date().toISOString(), sourceSha256,
  evidenceSourcesStatus: "Acceptance drivers are new uncommitted evidence at observation time; hashes above identify exact bytes. Historical merged driver and fixture files unchanged.",
}, null, 2) + "\n");
