// SDK probe-only observation. Reuse sibling argv/output recorder unchanged.
import "../rpc-53-3-linux/fixtures/record-argv.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.env.PROBE_MARKER_DIR && process.env.FOUNDRY_LAUNCH_ID) {
  process.on("uncaughtExceptionMonitor", error => {
    writeFileSync(join(process.env.PROBE_MARKER_DIR, `${process.env.FOUNDRY_LAUNCH_ID}.exception.log`), error.stack ?? String(error));
  });
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  writeFileSync(join(process.env.PROBE_MARKER_DIR, `${process.env.FOUNDRY_LAUNCH_ID}.process.json`), JSON.stringify({
    pid: process.pid, pgid: Number(fields[2]), launchId: process.env.FOUNDRY_LAUNCH_ID,
    slot: process.env.FOUNDRY_SLOT, runtime: process.env.FOUNDRY_WORKER_RUNTIME,
  }, null, 2));
}
