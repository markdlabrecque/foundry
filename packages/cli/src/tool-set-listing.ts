import { toolSetOf } from "@foundry/daemon/config";
import type { EffectiveStation, ToolSource } from "@foundry/daemon/config";

/** States what validation does not prove about extension tools (PRD §4 "Validation"). */
export const REGISTRATION_DISCLAIMER =
  "Extension tools are listed as configured; whether each extension registers them is not checked.";

const describeSource = (source: ToolSource): string => {
  switch (source._tag) {
    case "Pi":
      return "Pi built-in";
    case "Foundry":
      return "Foundry extension";
    case "Extension":
      return `extension ${source.path}`;
  }
};

/**
 * Renders each station's effective Tool Set, one tool per line with where it comes
 * from, followed by the registration disclaimer (PRD §4, §14).
 */
export const renderToolSets = (stations: ReadonlyArray<EffectiveStation>): ReadonlyArray<string> => {
  const lines: string[] = [];
  for (const station of stations) {
    const tools = toolSetOf(station);
    const width = Math.max(...tools.map((tool) => tool.name.length));
    lines.push(`Tool Set for ${station.address} (${tools.length} tools):`);
    for (const tool of tools) lines.push(`  ${tool.name.padEnd(width)}  ${describeSource(tool.source)}`);
  }
  lines.push(REGISTRATION_DISCLAIMER);
  return lines;
};
