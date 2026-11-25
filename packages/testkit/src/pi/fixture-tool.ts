/** Pi extension: registers the named fixture tool `fixture_echo`, which returns its `text` argument. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const FIXTURE_TOOL = "fixture_echo";

export default function fixtureToolExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: FIXTURE_TOOL,
    label: "Fixture echo",
    description: "Test fixture: return the given text unchanged.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: params.text }], details: {} };
    },
  });
}
