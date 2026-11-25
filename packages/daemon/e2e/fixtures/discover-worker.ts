// Test-only driver and observer: the production Foundry extension still owns the tool and channel.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_DISCOVER } from "@foundry/protocol";

export default function discoverWorker(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    pi.sendUserMessage(`@@ ${AGENT_DISCOVER} {}`);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === AGENT_DISCOVER) {
      const path = process.env["FOUNDRY_TEST_DISCOVERY_RESULT"];

      if (path === undefined) {throw new Error("missing discovery result fixture path");}

      writeFileSync(path, JSON.stringify(event));
    }
  });
}
