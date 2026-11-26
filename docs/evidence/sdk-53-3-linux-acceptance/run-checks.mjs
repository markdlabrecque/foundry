// Reuse ordinary no-shim regression runner; redirect only owned artifacts/temp prefix.
import { readFileSync } from "node:fs";
let source = readFileSync("docs/evidence/sdk-agent-collision-linux/run-checks.mjs", "utf8");
for (const [from, to] of [
  ['resolve("docs/evidence/sdk-agent-collision-linux/checks")', 'resolve("docs/evidence/sdk-53-3-linux-acceptance/checks")'],
  ['"f163c-"', '"f153ac-"'],
]) {
  if (source.split(from).length !== 2) throw new Error(`Runner drift: ${from}`);
  source = source.replace(from, to);
}
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
