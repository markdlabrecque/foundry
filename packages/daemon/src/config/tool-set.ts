import { FIXED_TOOLS, isPlainToolName, isReservedToolName, PI_BUILTIN_TOOLS } from "@foundry/protocol";
import type { NameProblem } from "./names.js";
import type { EffectiveStation } from "./resolve.js";
import type { FactoryConfig } from "./schema.js";

/**
 * Tool Sets (PRD §3.2 "Tool Set", §4 "Extension tools").
 *
 * A station's Tool Set is the twelve fixed tools plus the tools named on its effective
 * extensions. Its effective extensions are exactly one declared list (the factory default
 * or the station's own), so every tool-name rule can be checked where the names are
 * declared, and a problem points at the YAML line that names the tool.
 */

/** Where a tool in a Tool Set comes from. */
export type ToolSource =
  | { readonly _tag: "Pi" }
  | { readonly _tag: "Foundry" }
  | { readonly _tag: "Extension"; readonly path: string };

export interface ToolSetEntry {
  readonly name: string;
  readonly source: ToolSource;
}

type ExtensionList = NonNullable<NonNullable<FactoryConfig["defaults"]>["extensions"]>;

const checkList = (list: ExtensionList | undefined, at: ReadonlyArray<string>): NameProblem[] => {
  const problems: NameProblem[] = [];
  const firstAt = new Map<string, string>();
  (list ?? []).forEach((entry, index) => {
    if (typeof entry === "string") return;
    entry.tools.forEach((name, toolIndex) => {
      const path = [...at, String(index), "tools", String(toolIndex)];
      if (!isPlainToolName(name)) {
        problems.push({ path, message: `Tool name "${name}" must be an exact name of letters, digits, "_" and "-"; patterns are not allowed` });
      } else if (isReservedToolName(name)) {
        problems.push({ path, message: `Tool name "${name}" is reserved (Pi built-ins, agent tools, codemode, tool_search and mcp__ names)` });
      }
      const first = firstAt.get(name);
      if (first !== undefined) {
        problems.push({ path, message: `Tool name "${name}" is already named at ${first}; a tool appears once in a Tool Set` });
      } else {
        firstAt.set(name, path.join("."));
      }
    });
  });
  return problems;
};

/**
 * Checks extension tool names on a structurally valid configuration: exact names only,
 * no reserved name, and no name twice in one declared list (and so in any station's
 * effective set). Pure: it reads only the decoded value.
 */
export const checkToolNames = (config: FactoryConfig): ReadonlyArray<NameProblem> => {
  const problems = checkList(config.defaults?.extensions, ["defaults", "extensions"]);
  for (const [room, { stations }] of Object.entries(config.rooms)) {
    for (const [station, settings] of Object.entries(stations)) {
      problems.push(...checkList(settings.extensions, ["rooms", room, "stations", station, "extensions"]));
    }
  }
  return problems;
};

const PI_BUILTINS: ReadonlySet<string> = new Set(PI_BUILTIN_TOOLS);

/** A station's effective Tool Set in launch order, each tool with its source. */
export const toolSetOf = (station: Pick<EffectiveStation, "extensions">): ReadonlyArray<ToolSetEntry> => [
  ...FIXED_TOOLS.map((name): ToolSetEntry => ({
    name,
    source: PI_BUILTINS.has(name) ? { _tag: "Pi" } : { _tag: "Foundry" },
  })),
  ...station.extensions.flatMap((extension) =>
    extension.tools.map((name): ToolSetEntry => ({ name, source: { _tag: "Extension", path: extension.path } })),
  ),
];
