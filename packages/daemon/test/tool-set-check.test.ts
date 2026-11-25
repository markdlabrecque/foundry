// Unit tier: the expected Tool Set and its comparison with a reported one are pure functions of
// the effective station and the hello's tools; no socket, store or Pi is needed.
import { expect, test } from "vitest";
import { compareToolSet, expectedToolSet, isMatch } from "@foundry/daemon";
import type { ExpectedTool } from "@foundry/daemon";
import { PI_BUILTIN_TOOLS } from "@foundry/protocol";

const FOUNDRY = "/opt/foundry/extension/dist/index.js";
const PROJECT = "/factory/extensions/project.ts";

const station = { extensions: [{ path: "/factory/extensions/audit.ts", tools: [] }, { path: PROJECT, tools: ["web_fetch"] }] };

/** Stands in for macOS, where `/var` resolves to `/private/var`. */
const privateVar = (source: string) => source.replace(/^\/var\//, "/private/var/");

const builtins = PI_BUILTIN_TOOLS.map((name) => ({ name, source: `builtin:${name}` }));

test("the expected Tool Set includes Pi's built-ins, discovery, status, and each named extension tool", () => {
  expect(expectedToolSet(station, FOUNDRY)).toEqual([
    ...builtins,
    { name: "agent_discover", source: FOUNDRY },
    { name: "agent_status", source: FOUNDRY },
    { name: "web_fetch", source: PROJECT },
  ]);
});

test("a report naming exactly the expected tools with their sources matches, in any order", () => {
  const expected = expectedToolSet(station, FOUNDRY);

  expect(isMatch(compareToolSet(expected, [...expected].reverse()))).toBe(true);
});

test("missing, extra and replaced tools are each reported with their sources", () => {
  const expected: ReadonlyArray<ExpectedTool> = [
    ...builtins,
    { name: "agent_status", source: FOUNDRY },
    { name: "web_fetch", source: PROJECT },
  ];

  const discrepancy = compareToolSet(expected, [
    { name: "read", source: "/rogue.ts" }, // a built-in not from Pi
    { name: "bash", source: "builtin:bash" },
    { name: "edit", source: "builtin:edit" },
    { name: "write", source: "builtin:write" },
    { name: "agent_status", source: "/rogue.ts" }, // an agent tool not from the Foundry extension
    { name: "jira_get", source: PROJECT }, // not named in the YAML
  ]);

  expect(discrepancy).toEqual({
    missing: [{ name: "web_fetch", source: PROJECT }],
    extra: [{ name: "jira_get", source: PROJECT }],
    replaced: [
      { name: "read", expected: "builtin:read", actual: "/rogue.ts" },
      { name: "agent_status", expected: FOUNDRY, actual: "/rogue.ts" },
    ],
  });
  expect(isMatch(discrepancy)).toBe(false);
});

test("sources are compared canonically, so a symlinked path is the same extension", () => {
  const expected = [{ name: "web_fetch", source: "/var/x/project.ts" }];
  expect(isMatch(compareToolSet(expected, [{ name: "web_fetch", source: "/private/var/x/project.ts" }], privateVar))).toBe(true);
});
