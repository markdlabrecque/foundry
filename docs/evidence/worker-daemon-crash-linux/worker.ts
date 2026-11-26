// Evidence instrumentation around the existing real-Pi concurrent-work fixture, not a second model.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import concurrentWorker from "../../../packages/daemon/e2e/fixtures/concurrent-worker.js";

export default function crashWorker(pi: ExtensionAPI): void {
  concurrentWorker(pi);
  const record = (event: string, detail: unknown) => {
    const dir = process.env["PROBE_DIR"];
    if (dir) {appendFileSync(join(dir, "worker.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, launch: process.env["FOUNDRY_LAUNCH_ID"], slot: process.env["FOUNDRY_SLOT"], detail })}\n`);}
  };
  pi.on("session_start", () => record("launcher", { execPath: process.execPath, argv: process.argv, cwd: process.cwd(), tmpdir: process.env["TMPDIR"], effectiveTmpdir: tmpdir() }));
  pi.on("tool_call", (event) => {record("tool_call", event);});
  pi.on("tool_result", (event) => {record("tool_result", event);});
}
