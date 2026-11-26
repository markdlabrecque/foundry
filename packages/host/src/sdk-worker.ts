/** SDK process entry. Host-generated RPC-compatible argv selects resources, not traffic.
 * All Foundry delivery/control/tool traffic stays on the extension's channel.
 */
import { getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";
import { createSdkSession } from "./sdk-session.js";

const parsed = parseArgs(process.argv.slice(2));

if (parsed.diagnostics.length > 0 || parsed.unknownFlags.size > 0 || !parsed.model || !parsed.sessionId || !parsed.tools) {
  throw new Error("SDK worker requires the host's explicit model, session ID and tool list");
}

const { session } = await createSdkSession({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  model: parsed.model,
  conversationRef: parsed.sessionId,
  extensions: parsed.extensions ?? [],
  skills: parsed.skills ?? [],
  tools: parsed.tools,
});

// Remain host-owned even if the daemon/channel goes away. No stdin command protocol.
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;

const stop = async () => {
  if (stopping) {return;}

  stopping = true;

  try {
    await session.abort();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
    clearInterval(keepAlive);
  }
};

process.once("SIGTERM", () => void stop());

process.once("SIGINT", () => void stop());
