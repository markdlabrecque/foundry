import { describe, expect, test } from "vitest";
import { decodeFactoryYaml, locateProblems, resolveStations } from "@foundry/daemon/config";
import type { EffectiveStation, ResolveResult } from "@foundry/daemon/config";

// Unit tier: resolution is a pure function of decoded config, an injected
// environment and the YAML's directory. No files are read.
const baseDir = "/factory";

/** A factory whose `defaults` and one station's settings vary per case. */
const factory = (defaults: string, room: string, station: string): string => `version: 1
name: f
repository:
  source: ../p
  default_branch: main
default_production_line: l
${defaults === "" ? "" : `defaults:\n${defaults}`}rooms:
  eng:
${room}    stations:
      dev:
${station === "" ? "        isolation: none\n" : station}production_lines:
  l:
    stages:
      - id: a
        station: eng.dev
`;

const resolveText = (text: string, env: Record<string, string | undefined> = {}): ResolveResult => {
  const decoded = decodeFactoryYaml(text);
  if (decoded._tag === "Invalid") throw new Error(JSON.stringify(decoded.problems));
  return resolveStations(decoded.config, { env, baseDir });
};

const stationOf = (result: ResolveResult): EffectiveStation => {
  if (result._tag === "Invalid") throw new Error(JSON.stringify(result.problems));
  const [station] = result.stations;
  if (station === undefined) throw new Error("no station");
  return station;
};

const MODEL = "  model: p/m\n";

describe("instructions compose factory → room → station", () => {
  const rows: ReadonlyArray<[string, string, string, string, ReadonlyArray<string>]> = [
    ["all three levels", `${MODEL}  instructions: factory.md\n`, "    instructions: rooms/eng.md\n", "        instructions: roles/dev.md\n", ["/factory/factory.md", "/factory/rooms/eng.md", "/factory/roles/dev.md"]],
    ["factory and station only", `${MODEL}  instructions: factory.md\n`, "", "        instructions: roles/dev.md\n", ["/factory/factory.md", "/factory/roles/dev.md"]],
    ["room only", MODEL, "    instructions: rooms/eng.md\n", "", ["/factory/rooms/eng.md"]],
    ["none", MODEL, "", "", []],
    ["absolute path kept", `${MODEL}  instructions: /abs/factory.md\n`, "", "", ["/abs/factory.md"]],
  ];
  test.each(rows)("%s", (_name, defaults, room, station, expected) => {
    expect(stationOf(resolveText(factory(defaults, room, station))).instructions).toEqual(expected);
  });
});

describe("model", () => {
  const resolved: ReadonlyArray<[string, string, string, Record<string, string>, string]> = [
    ["inherits the factory default", "  model: p/default\n", "", {}, "p/default"],
    ["station overrides the default", "  model: p/default\n", "        model: p/station\n", {}, "p/station"],
    ["station model with no default", "", "        model: p/station\n", {}, "p/station"],
    ["default placeholder from env", "  model: ${DEFAULT_MODEL}\n", "", { DEFAULT_MODEL: "p/env" }, "p/env"],
    ["station placeholder overrides", "  model: ${DEFAULT_MODEL}\n", "        model: ${REVIEW_MODEL}\n", { DEFAULT_MODEL: "p/d", REVIEW_MODEL: "p/r" }, "p/r"],
    // Placeholders expand only as a whole field; a partial one stays literal.
    ["partial placeholder is literal", "  model: p/${X}\n", "", { X: "m" }, "p/${X}"],
  ];
  test.each(resolved)("%s", (_name, defaults, station, env, expected) => {
    expect(stationOf(resolveText(factory(defaults, "", station), env)).model).toBe(expected);
  });

  // Each row: the env, then the path and message of the problem reported.
  const rejected: ReadonlyArray<[string, string, string, Record<string, string>, { path: string; message: RegExp }]> = [
    ["unset station variable", "", "        model: ${REVIEW_MODEL}\n", {}, { path: "rooms.eng.stations.dev.model", message: /REVIEW_MODEL is not set/ }],
    ["empty station variable", "", "        model: ${REVIEW_MODEL}\n", { REVIEW_MODEL: "" }, { path: "rooms.eng.stations.dev.model", message: /REVIEW_MODEL is empty/ }],
    ["unset default variable", "  model: ${DEFAULT_MODEL}\n", "", {}, { path: "defaults.model", message: /DEFAULT_MODEL is not set/ }],
    ["empty default variable, even when overridden", "  model: ${DEFAULT_MODEL}\n", "        model: p/m\n", { DEFAULT_MODEL: "" }, { path: "defaults.model", message: /DEFAULT_MODEL is empty/ }],
    ["no model anywhere", "", "", {}, { path: "rooms.eng.stations.dev", message: /No model/ }],
    ["not a provider/model selector", "  model: sonnet\n", "", {}, { path: "defaults.model", message: /provider\/model/ }],
    ["variable value not a selector", "  model: ${DEFAULT_MODEL}\n", "", { DEFAULT_MODEL: "sonnet" }, { path: "defaults.model", message: /"sonnet" \(from \$\{DEFAULT_MODEL\}\)/ }],
  ];
  test.each(rejected)("%s", (_name, defaults, station, env, expected) => {
    const result = resolveText(factory(defaults, "", station), env);
    expect(result._tag).toBe("Invalid");
    if (result._tag !== "Invalid") return;
    expect(result.problems).toContainEqual({ path: expected.path, message: expect.stringMatching(expected.message) });
  });
});

describe("skills and extensions: omission inherits, a list replaces, [] clears", () => {
  const defaults = `${MODEL}  skills: [skills/a/SKILL.md]
  extensions:
    - ext/hooks.ts
    - path: ext/tools.ts
      tools: [web_fetch, jira_get]
`;
  const inherited = {
    skills: ["/factory/skills/a/SKILL.md"],
    extensions: [
      { path: "/factory/ext/hooks.ts", tools: [] },
      { path: "/factory/ext/tools.ts", tools: ["web_fetch", "jira_get"] },
    ],
  };
  const rows: ReadonlyArray<[string, string, string, { skills: ReadonlyArray<string>; extensions: ReadonlyArray<unknown> }]> = [
    ["omitted: both inherit with their tools", defaults, "", inherited],
    ["skills replaced, extensions inherit", defaults, "        skills: [skills/b/SKILL.md]\n", { ...inherited, skills: ["/factory/skills/b/SKILL.md"] }],
    ["extensions replaced with own tools", defaults, "        extensions: [{ path: ext/other.ts, tools: [x] }]\n", { ...inherited, extensions: [{ path: "/factory/ext/other.ts", tools: ["x"] }] }],
    ["explicit [] clears skills", defaults, "        skills: []\n", { ...inherited, skills: [] }],
    ["explicit [] clears extensions and their tools", defaults, "        extensions: []\n", { ...inherited, extensions: [] }],
    ["no defaults and omitted: empty", MODEL, "", { skills: [], extensions: [] }],
  ];
  test.each(rows)("%s", (_name, defaultsText, station, expected) => {
    const resolved = stationOf(resolveText(factory(defaultsText, "", station)));
    expect({ skills: resolved.skills, extensions: resolved.extensions }).toEqual(expected);
  });
});

test("each station carries its address, pool size and isolation", () => {
  const resolved = stationOf(resolveText(factory(MODEL, "", "        instances: 2\n        isolation: worktree\n")));
  expect(resolved).toMatchObject({ address: "eng.dev", room: "eng", station: "dev", instances: 2, isolation: "worktree" });
});

test("resolution problems are located at their YAML setting", () => {
  const text = factory("", "", "        model: ${REVIEW_MODEL}\n");
  const result = resolveText(text);
  if (result._tag !== "Invalid") throw new Error("expected a problem");
  expect(locateProblems(text, result.problems)).toContainEqual(
    expect.objectContaining({ path: "rooms.eng.stations.dev.model", line: 11 }),
  );
});

test("a leading ~ expands to the home directory, as in the offline checks", () => {
  const decoded = decodeFactoryYaml(factory(`${MODEL}  instructions: ~/shared/factory.md\n`, "", "        skills: [~/skills/a/SKILL.md]\n"));
  if (decoded._tag === "Invalid") throw new Error(JSON.stringify(decoded.problems));
  const resolved = stationOf(resolveStations(decoded.config, { env: {}, baseDir, home: "/home/op" }));
  expect({ instructions: resolved.instructions, skills: resolved.skills }).toEqual({
    instructions: ["/home/op/shared/factory.md"],
    skills: ["/home/op/skills/a/SKILL.md"],
  });
});
