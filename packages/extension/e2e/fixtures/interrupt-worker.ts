/**
 * Pi extension fixture for the interrupt journey: opens the real Foundry
 * channel to the socket in FOUNDRY_TEST_CHANNEL_SOCKET, answers `interrupt`
 * frames with the real RunInterrupter, and registers `fixture_block`, a tool
 * that only returns when its run is aborted, so a run can be held active.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { interruptRuns, openChannel, RunInterrupter, type OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION } from "@foundry/protocol";

export const BLOCK_TOOL = "fixture_block";

export default function interruptWorker(pi: ExtensionAPI): void {
  const socketPath = process.env["FOUNDRY_TEST_CHANNEL_SOCKET"];
  if (!socketPath) throw new Error("FOUNDRY_TEST_CHANNEL_SOCKET is not set");
  const interrupter = new RunInterrupter();
  interruptRuns(pi, interrupter);
  let channel: OpenChannel | undefined;

  pi.registerTool({
    name: BLOCK_TOOL,
    label: "Fixture block",
    description: "Test fixture: wait until the run is aborted.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { content: [{ type: "text", text: "aborted" }], details: {} };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (channel) return;
    const opened = await openChannel({
      socketPath,
      hello: {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        factoryId: "f1",
        slotId: "builder-1",
        launchId: "launch-1",
        conversationRef: ctx.sessionManager.getSessionId(),
        hasRecoverableHistory: false,
        mode: "headless",
        tools: [],
      },
      onFrame: (frame, ch) => {
        if (frame.type === "interrupt") interrupter.handle(frame, ch);
      },
    });
    if (opened.accepted) channel = opened.channel;
  });
  pi.on("session_shutdown", () => {
    channel?.close();
    channel = undefined;
  });
}
