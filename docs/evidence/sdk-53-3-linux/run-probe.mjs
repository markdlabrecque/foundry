#!/usr/bin/env node
// Manual real-process evidence, deliberately outside Vitest. Reuse FOU-108's fixture/driver
// rather than reimplementing its configuration or product checks. Fail if a splice drifts.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
let source = readFileSync(join(here, "../rpc-53-3-linux/run-probe.mjs"), "utf8");
const replace = (from, to) => {
  if (source.split(from).length !== 2) throw new Error(`Sibling driver changed: ${from}`);
  source = source.replace(from, to);
};
replace('const fixtures = join(here, "fixtures");', `const fixtures = ${JSON.stringify(resolve(here, "../rpc-53-3-linux/fixtures"))};`);
replace('"fou108-', '"fou153-'); // output directory prefix only
replace('`fou108-${name}-`', '`fou153-${name}-`');
replace('    FOUNDRY_HOME:', '    FOUNDRY_WORKER_RUNTIME: "sdk",\n    FOUNDRY_HOME:');
replace('join(fixtures, "record-argv.mjs")', JSON.stringify(join(here, "record-process.mjs")));
replace('  } finally {\n    result.shutdown', `  } catch (error) {
    result.observationError = String(error);
    result.daemonOutput = daemonOut;
    result.holdList = cli("hold", "list");
    result.slotList = cli("slot", "list");
    result.slotShow = slots.map(s => cli("slot", "show", s));
    result.markers = Object.fromEntries(readdirSync(markers).sort().map(f => {
      const value = readFileSync(join(markers, f), "utf8");
      return [f, f.endsWith(".log") ? value : JSON.parse(value)];
    }));
  } finally {
    const owned = readdirSync(markers).filter(f => f.endsWith(".process.json")).map(f => JSON.parse(readFileSync(join(markers, f), "utf8")));
    result.ownedProcesses = owned;
    result.shutdown`);
replace('    // Removed even when the variant failed, so an aborted run leaves no disposable root behind.\n    rmSync(root, { recursive: true, force: true });', `    const groupMembers = () => {
      const groups = new Set(owned.filter(p => p.pid === p.pgid).map(p => p.pgid));
      return execFileSync("ps", ["-eo", "pid=,pgid=,stat=,args="], { encoding: "utf8" }).split("\\n").filter(l => groups.has(Number(l.trim().split(/\\s+/)[1])));
    };
    // A marker authenticates the group as this disposable launch; never signal arbitrary PIDs.
    await poll("owned groups to disappear", () => groupMembers().length === 0, 20_000).catch(error => { result.cleanupError = String(error); });
    result.cleanup = { ownedGroups: owned.map(p => p.pgid), remaining: groupMembers(), daemonExited: daemon.exitCode !== null || daemon.signalCode !== null };
    if (result.cleanup.remaining.length === 0 && result.cleanup.daemonExited) {
      rmSync(root, { recursive: true, force: true });
      result.cleanup.rootRemoved = !existsSync(root);
    }`);
replace('  console.log(`${name}: written ${join(outDir, `${name}.json`)}`);', '  console.log(`${name}: written ${join(outDir, `${name}.json`)}`);\n  if (result.observationError || result.cleanupError) throw new Error(`Stopped at ${name}; see retained result`);');
// Same directory preserves sibling repo-root resolution. Always remove generated file.
const generated = join(here, `.generated-${process.pid}.mjs`);
writeFileSync(generated, source);
try { await import(generated); } finally { unlinkSync(generated); }
