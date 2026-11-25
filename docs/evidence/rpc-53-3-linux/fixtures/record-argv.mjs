// Node `--import` preload, passed to every process of a probe run through NODE_OPTIONS. Inside a
// Foundry launch (FOUNDRY_SLOT and FOUNDRY_LAUNCH_ID set by the Worker Host) it records the exact
// argv the host spawned, before Pi overwrites process.title (which blanks /proc/<pid>/cmdline),
// and tees everything the worker writes to stderr and stdout, so any Pi load error or diagnostic
// is kept (the host retains stderr only for unexpected exits, and discards stdout).
// It records only; the launcher is the default one, unchanged.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PROBE_MARKER_DIR;
const slot = process.env.FOUNDRY_SLOT;
const launchId = process.env.FOUNDRY_LAUNCH_ID;
if (dir && slot && launchId) {
  const base = join(dir, `${slot.replace("/", "_")}.launch.${launchId}`);
  writeFileSync(`${base}.json`, JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(1), cwd: process.cwd() }, null, 2));
  for (const stream of ["stderr", "stdout"]) {
    const file = `${base}.${stream}.log`;
    writeFileSync(file, "");
    const original = process[stream].write.bind(process[stream]);
    process[stream].write = (chunk, ...rest) => {
      try {
        appendFileSync(file, typeof chunk === "string" ? chunk : Buffer.from(chunk));
      } catch {}
      return original(chunk, ...rest);
    };
  }
}
