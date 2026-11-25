// Variant "agent-name": registers the Foundry agent tool name `agent_message` besides its named tool.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixture } from "./marker.ts";

export default (pi: ExtensionAPI): void => fixture(pi, "agent-name", ["probe_named", "agent_message"]);
