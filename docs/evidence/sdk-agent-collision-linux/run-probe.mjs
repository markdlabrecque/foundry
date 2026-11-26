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
replace('"fou108-', '"fou163-'); // output directory prefix only
replace('`fou108-${name}-`', '`fou163-${name}-`');
replace('const MODEL = "probe-local/inert";', 'const MODEL = "openai/gpt-4.1-mini";');
replace('  writeFileSync(join(agent, "models.json"), JSON.stringify(MODELS_JSON));', '  writeFileSync(join(agent, "auth.json"), JSON.stringify({openai: {type: "api_key", key: "none"}}));');
replace('    FOUNDRY_HOME:', '    FOUNDRY_WORKER_RUNTIME: "sdk",\n    TMPDIR: process.env.TMPDIR,\n    FOUNDRY_HOME:');
replace('Object.entries(VARIANTS)', '["missing", "reserved", "cleared", "agent-name"].map(name => [name, VARIANTS[name]])');
replace('join(fixtures, "record-argv.mjs")', JSON.stringify(join(here, "../sdk-53-3-linux/record-process.mjs")));
replace('  } finally {\n    result.shutdown', `  } catch (error) {
    result.observationError = String(error);
    result.daemonOutput = daemonOut;
    result.holdList = cli("hold", "list");
    const holds = JSON.parse(cli("hold", "list", "--json").out).result.holds;
    result.holdShow = holds.map(h => cli("hold", "show", String(h.id)));
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
    result.markers = Object.fromEntries(readdirSync(markers).sort().map(f => {
      const value = readFileSync(join(markers, f), "utf8");
      return [f, f.endsWith(".log") ? value : JSON.parse(value)];
    }));
    result.cleanup = { ownedGroups: owned.map(p => p.pgid), remaining: groupMembers(), daemonExited: daemon.exitCode !== null || daemon.signalCode !== null };
    if (result.cleanup.remaining.length === 0 && result.cleanup.daemonExited) {
      rmSync(root, { recursive: true, force: true });
      result.cleanup.rootRemoved = !existsSync(root);
    }`);
replace('  console.log(`${name}: written ${join(outDir, `${name}.json`)}`);', '  console.log(`${name}: written ${join(outDir, `${name}.json`)}`);\n  if (result.observationError || result.cleanupError) throw new Error(`Stopped at ${name}; see retained result`);');
// Pre-hello collisions have no hello. Require the named operator hold instead.
replace('    await poll("every slot\'s hello", () => outcomes(log()).length >= slots.length);', `    if (name === "agent-name") {
      await poll("named collision hold", () => cli("hold", "list").out.includes("frozen_slot"));
      await poll("collision launch end", () => log().some(e => e.msg === "launch ended"));
    } else {
      await poll("every slot's hello", () => outcomes(log()).length >= slots.length);
    }`);
replace('  const daemon = spawn(', '  let daemon = spawn(');
// Preserve the collision snapshots, then correct only the disposable YAML and
// use the documented daemon-restart + unfreeze workflow in the same conversation.
replace('  } catch (error) {\n    result.observationError', `    if (name === "agent-name") {
      result.failedUnfreeze = cli("slot", "unfreeze", "dev/1");
      result.failedRecheckHold = cli("hold", "show", String(holds[0].id));
      result.beforeCorrection = cli("slot", "show", "dev/1", "--json");
      daemon.kill("SIGTERM");
      await poll("old daemon exit", () => daemon.exitCode !== null || daemon.signalCode !== null);
      writeFileSync(factory, yaml.replace("agent-name.ts", "named.ts"));
      daemonOut = "";
      daemon = spawn(process.execPath, [daemonMain, "--home", home, factory], {env, stdio: ["ignore", "pipe", "pipe"]});
      daemon.stdout.on("data", c => daemonOut += c);
      daemon.stderr.on("data", c => daemonOut += c);
      await poll("restarted management API", () => daemonOut.includes("management API on"));
      result.stillFrozenAfterRestart = cli("slot", "show", "dev/1");
      result.unfreeze = cli("slot", "unfreeze", "dev/1");
      result.afterCorrection = cli("slot", "show", "dev/1", "--json");
      result.correctedHolds = cli("hold", "list");
      result.correctedLog = log();
    }
  } catch (error) {
    result.observationError`);
// Same directory preserves sibling repo-root resolution. Always remove generated file.
const generated = join(here, `.generated-${process.pid}.mjs`);
writeFileSync(generated, source);
try { await import(generated); } finally { unlinkSync(generated); }
