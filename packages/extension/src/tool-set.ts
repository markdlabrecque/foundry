/**
 * The Tool Set Pi actually registered, as the extension reports it in `hello`
 * (PRD §4 "Extension tools", §14, §17.2). It is observed, not expected: what the
 * daemon configured is compared with it elsewhere (12b).
 *
 * A tool is reported only when the worker is offered it: registered, kept by the
 * launch's `--tools` allowlist and active (declared to the model). So a tool an
 * extension registers but the YAML does not name is absent, and so is a named
 * tool whose exposure is `hidden`, or an unnamed `mcp__` tool Pi keeps registered
 * but inactive. A named `codemode` or `deferred` tool is active, so it is reported. Each tool carries
 * the source Pi attributes it to: `builtin:<name>` for Pi's own tools, otherwise
 * the path of the extension that registered it. An extension that registers a
 * reserved name such as `read`, or a name another extension already registered,
 * shows up under whichever source Pi actually uses for it.
 *
 * For 12b: `source` is the path Pi was given, so compare canonical paths (macOS
 * `/var` is `/private/var`); an SDK-loaded extension has a synthetic `<inline:…>`
 * path; and a `hidden` tool replacing `read` shows as `read` missing, not replaced.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReportedTool } from "@foundry/protocol";

/** The two Pi calls the report needs. They throw while extensions are still loading. */
export type ToolRegistryView = Pick<ExtensionAPI, "getAllTools" | "getActiveTools">;

/**
 * Read the registered Tool Set now. Its order is Pi's and carries no meaning. Call it at each hello
 * (from `session_start` on), not once at load: extensions may register tools later.
 */
export const registeredToolSet = (pi: ToolRegistryView): Array<ReportedTool> => {
  const sourceByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool.sourceInfo.path]));

  return pi.getActiveTools().flatMap((name) => {
    const source = sourceByName.get(name);

    return source === undefined ? [] : [{ name, source }];
  });
};
