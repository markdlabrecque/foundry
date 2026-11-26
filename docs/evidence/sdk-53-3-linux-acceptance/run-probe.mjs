// Post-merge acceptance: reuse the merged candidate driver; only add read-only
// host/CLI snapshots. No product or fixture behavior is changed.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
let source = readFileSync(join(here, "../sdk-agent-collision-linux/run-probe.mjs"), "utf8");
const correction = '      writeFileSync(factory, yaml.replace("agent-name.ts", "named.ts"));';
if (source.split(correction).length !== 2) throw new Error("Correction snapshot drift");
source = source.replace(correction, correction + '\n      result.correctedFactoryYaml = readFileSync(factory, "utf8");');
const anchor = "// Same directory preserves sibling repo-root resolution.";
if (source.split(anchor).length !== 2) throw new Error("Candidate driver drift");
source = source.replace(anchor, `replace('    result.slotShow = slots.map((s) => cli("slot", "show", s));', \`    result.slotShow = slots.map((s) => cli("slot", "show", s));
    result.slotJson = slots.map(s => cli("slot", "show", s, "--json"));
    result.ticketList = cli("ticket", "list", "--json");
    result.fullDaemonLog = log();
    const { connectHost } = await import(join(repo, "packages/host/dist/client.js"));
    const host = await connectHost(home);
    try {
      result.hostIdentity = await host.identify();
      result.hostInventory = await host.inventory();
    } finally { host.close(); }
\`);
${anchor}`);
const generated = join(here, `.acceptance-${process.pid}.mjs`);
writeFileSync(generated, source);
try { await import(generated); } finally { unlinkSync(generated); }
