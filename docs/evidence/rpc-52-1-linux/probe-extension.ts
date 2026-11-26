// FOU-83 survival-and-reconnect probe extension for pinned Pi 1.6.0. A disposable fixture, not Foundry code.
//
// Loaded as a station extension (the YAML names its `probe_hold` tool). It:
// - registers the credential-free faux model `probe/busy`: every run calls `probe_hold` once, then
//   answers "done";
// - registers `probe_hold`, which records the worker's identity and exact launcher in $PROBE_DIR,
//   then holds the run open until Pi aborts it, so the worker is busy for the whole probe;
// - starts one run shortly after `session_start`, after the Foundry extension has dialled the daemon.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const PROBE_DIR = process.env.PROBE_DIR;
const factoryId = process.env.FOUNDRY_FACTORY_ID ?? "unknown";
const slotId = process.env.FOUNDRY_SLOT ?? "unknown";
const launchId = process.env.FOUNDRY_LAUNCH_ID ?? "unknown";

export default function probe(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: "probe",
    api: "probe-faux",
    models: [{ id: "busy", name: "Probe busy", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1024 }],
  });

  let calls = 0;

  faux.setResponses([
    function respond(context) {
      faux.appendResponses([respond]);
      const last = context.messages.at(-1);

      if (last?.role === "toolResult") {return fauxAssistantMessage(fauxText("done"));}

      calls += 1;

      return fauxAssistantMessage(fauxToolCall("probe_hold", {}, { id: `hold-${calls}` }), { stopReason: "toolUse" });
    },
  ]);
  pi.registerProvider(faux.provider);

  pi.registerTool({
    name: "probe_hold",
    label: "Probe hold",
    description: "Probe fixture: hold the run open until aborted, so the worker stays busy.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (PROBE_DIR !== undefined) {
        writeFileSync(
          join(PROBE_DIR, `hold-${factoryId}-${slotId.replace("/", "_")}.json`),
          JSON.stringify({
            factoryId,
            slotId,
            launchId,
            workerPid: process.pid,
            at: new Date().toISOString(),
            // The worker's exact launcher: executable, argv and cwd as the Worker Host spawned it.
            execPath: process.execPath,
            argv: process.argv.slice(1),
            cwd: process.cwd(),
          }),
        );
      }

      await new Promise<void>((resolve) => {
        if (signal?.aborted) {resolve();}
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });

      return { content: [{ type: "text", text: "held" }], details: {} };
    },
  });

  let started = false;

  pi.on("session_start", () => {
    if (started) {return;}

    started = true;
    setTimeout(() => {
      void pi.sendUserMessage("hold");
    }, 1500).unref();
  });
}
