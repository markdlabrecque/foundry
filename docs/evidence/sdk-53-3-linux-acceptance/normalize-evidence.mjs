// Same normalization contract as the merged candidate; never rewrite historical artifacts.
import { readFileSync } from "node:fs";
let source = readFileSync("docs/evidence/sdk-agent-collision-linux/normalize-evidence.mjs", "utf8");
for (const [from, to] of [
  ['resolve("docs/evidence/sdk-agent-collision-linux")', 'resolve("docs/evidence/sdk-53-3-linux-acceptance")'],
  ['join(homedir(), "f163")', 'join(homedir(), "f153a")'],
]) {
  if (source.split(from).length !== 2) throw new Error(`Normalizer drift: ${from}`);
  source = source.replace(from, to);
}
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
