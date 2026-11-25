// Variant "cleared": the factory default extension, naming probe_named. A station inheriting the
// default gets it; a station with `extensions: []` must get neither this extension nor its tool.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixture } from "./marker.ts";

export default (pi: ExtensionAPI): void => fixture(pi, "named", ["probe_named"]);
