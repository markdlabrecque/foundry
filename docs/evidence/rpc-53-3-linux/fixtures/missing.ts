// Variant "missing": the YAML names probe_absent on this extension, which never registers it.
// It registers probe_unnamed instead, which the YAML does not name.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixture } from "./marker.ts";

export default (pi: ExtensionAPI): void => fixture(pi, "missing", ["probe_unnamed"]);
