import { describe, expect, test } from "vitest";
import { FIXED_TOOLS } from "@foundry/protocol";
import { decodeFactoryYaml, resolveStations, toolSetOf } from "@foundry/daemon/config";
import type { ToolSetEntry } from "@foundry/daemon/config";

// Unit tier: Tool Sets are a pure function of decoded config; no files are read.

/** A factory whose `defaults` block and the `eng.dev` station's settings vary per case; `ops.gate` only completes the line's final-stage contract. */
const factory = (defaults: string, station: string): string => `version: 1
name: f
repository:
  source: ../p
  default_branch: main
default_production_line: l
defaults:
  model: p/m
${defaults}rooms:
  eng:
    stations:
      dev:
${station === "" ? "        isolation: none\n" : station}  ops:
    stations:
      gate: { isolation: worktree, model: p/m }
production_lines:
  l:
    stages:
      - id: a
        station: eng.dev
      - id: w
        station: ops.gate
        writing: true
      - id: z
        station: ops.gate
        approval: true
        on_rejection: w
`;

const DEFAULTS = `  extensions:
    - ext/hooks.ts
    - path: ext/tools.ts
      tools: [web_fetch, jira_get]
`;

const toolSet = (text: string): ReadonlyArray<ToolSetEntry> => {
  const decoded = decodeFactoryYaml(text);

  if (decoded._tag === "Invalid") {throw new Error(JSON.stringify(decoded.problems));}

  const resolved = resolveStations(decoded.config, { env: {}, baseDir: "/factory" });

  if (resolved._tag === "Invalid") {throw new Error(JSON.stringify(resolved.problems));}

  return toolSetOf(resolved.stations[0]!);
};

const fixed: ReadonlyArray<ToolSetEntry> = FIXED_TOOLS.map((name, index) => ({
  name,
  source: index < 4 ? { _tag: "Pi" } : { _tag: "Foundry" },
}));

const from = (path: string, ...names: Array<string>): Array<ToolSetEntry> =>
  names.map((name) => ({ name, source: { _tag: "Extension", path } }));

describe("a Tool Set is the fixed tools plus those named on the effective extensions", () => {
  const rows: ReadonlyArray<[string, string, string, ReadonlyArray<ToolSetEntry>]> = [
    ["inherited extension tools keep their source", DEFAULTS, "", [...fixed, ...from("/factory/ext/tools.ts", "web_fetch", "jira_get")]],
    ["a replacing list brings only its own tools", DEFAULTS, "        extensions: [{ path: ext/other.ts, tools: [lint] }]\n", [...fixed, ...from("/factory/ext/other.ts", "lint")]],
    ["[] clears every extension tool", DEFAULTS, "        extensions: []\n", fixed],
    ["a hooks-only extension adds no tools", "  extensions: [ext/hooks.ts]\n", "", fixed],
  ];

  test.each(rows)("%s", (_name, defaults, station, expected) => {
    expect(toolSet(factory(defaults, station))).toEqual(expected);
  });
});

describe("extension tool names are exact, unreserved and listed once", () => {
  const ext = (tools: string): string => `  extensions:\n    - path: ext/a.ts\n      tools: ${tools}\n`;

  // Each row: the defaults block, then the problem path and message.
  const rejected: ReadonlyArray<[string, string, string, string, RegExp]> = [
    ["an enabled Pi built-in", ext("[bash]"), "", "defaults.extensions.0.tools.0", /"bash" is reserved/],
    ["a Pi built-in a worker does not get", ext("[grep]"), "", "defaults.extensions.0.tools.0", /"grep" is reserved/],
    ["an agent tool", ext("[ok, agent_message]"), "", "defaults.extensions.0.tools.1", /"agent_message" is reserved/],
    ["codemode", ext("[codemode]"), "", "defaults.extensions.0.tools.0", /"codemode" is reserved/],
    ["tool_search", ext("[tool_search]"), "", "defaults.extensions.0.tools.0", /"tool_search" is reserved/],
    ["an mcp__ name", ext("[mcp__github__search]"), "", "defaults.extensions.0.tools.0", /"mcp__github__search" is reserved/],
    ["a pattern", ext('["web_*"]'), "", "defaults.extensions.0.tools.0", /exact name/],
    ["a name twice on one extension", ext("[web_fetch, web_fetch]"), "", "defaults.extensions.0.tools.1", /already named at defaults\.extensions\.0\.tools\.0/],
    [
      "a name on two of a station's extensions",
      "",
      "        extensions:\n          - { path: ext/a.ts, tools: [web_fetch] }\n          - { path: ext/b.ts, tools: [web_fetch] }\n",
      "rooms.eng.stations.dev.extensions.1.tools.0",
      /already named/,
    ],
    ["a reserved name on a station's own list", "", "        extensions: [{ path: ext/a.ts, tools: [write] }]\n", "rooms.eng.stations.dev.extensions.0.tools.0", /"write" is reserved/],
  ];

  test.each(rejected)("rejects %s", (_name, defaults, station, path, message) => {
    const decoded = decodeFactoryYaml(factory(defaults, station));
    expect(decoded._tag).toBe("Invalid");

    if (decoded._tag !== "Invalid") {return;}

    expect(decoded.problems).toContainEqual(
      expect.objectContaining({ path, message: expect.stringMatching(message), line: expect.any(Number) }),
    );
  });

  test("a problem points at the line naming the tool", () => {
    const decoded = decodeFactoryYaml(factory(ext("[ok, agent_message]"), ""));

    if (decoded._tag !== "Invalid") {throw new Error("expected a problem");}

    expect(decoded.problems).toEqual([expect.objectContaining({ line: 11, column: 19 })]);
  });

  test("the same name on a default and a replacing station list is not a duplicate", () => {
    const set = toolSet(factory(ext("[web_fetch]"), "        extensions: [{ path: ext/b.ts, tools: [web_fetch] }]\n"));
    expect(set.slice(FIXED_TOOLS.length)).toEqual(from("/factory/ext/b.ts", "web_fetch"));
  });
});
