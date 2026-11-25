// Node `--import` preload, passed to every process of a probe run through NODE_OPTIONS. Inside a
// Foundry launch (FOUNDRY_SLOT and FOUNDRY_LAUNCH_ID set by the Worker Host) it records the exact
// argv the host spawned, before Pi overwrites process.title (which blanks /proc/<pid>/cmdline).
// It records only; the launcher is the default one, unchanged.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PROBE_MARKER_DIR;
const slot = process.env.FOUNDRY_SLOT;
const launchId = process.env.FOUNDRY_LAUNCH_ID;
if (dir && slot && launchId) {
  writeFileSync(
    join(dir, `${slot.replace("/", "_")}.launch.${launchId}.json`),
    JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(1), cwd: process.cwd() }, null, 2),
  );
}
