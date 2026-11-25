// Variant "reserved": registers Pi's reserved built-in name `read` besides its named tool.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixture } from "./marker.ts";

export default (pi: ExtensionAPI): void => fixture(pi, "reserved", ["probe_named", "read"]);
