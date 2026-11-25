import { describe, expect, test } from "vitest";
import { decodeFactoryYaml } from "@foundry/daemon/config";
import type { ConfigProblem } from "@foundry/daemon/config";

/** A minimal valid factory; cases replace or append lines to it. */
const minimal = `version: 1
name: example-factory
repository:
  source: ../example-project
  default_branch: main
default_production_line: feature
rooms:
  engineering:
    stations:
      developer:
        isolation: worktree
production_lines:
  feature:
    stages:
      - id: develop
        station: engineering.developer
        writing: true
      - id: integrate
        station: engineering.developer
        approval: true
        on_rejection: develop
`;

/** The PRD §4 example, verbatim in shape. */
const prdExample = `version: 1
name: example-factory
repository:
  source: ../example-project
  default_branch: main
default_production_line: feature
worktrees:
  root: ~/worktrees
  branch_pattern: 'ticket/{ticket-id}-{slug}'
  after_create: [./scripts/setup-worktree]
  before_remove: [./scripts/cleanup-worktree]
knowledge:
  root: knowledge
message_budget: 100
delegation_depth_limit: 2
recovery_limit: 3
defaults:
  instructions: factory.md
  model: \${DEFAULT_MODEL}
  skills: [skills/project/SKILL.md]
  extensions:
    - extensions/audit.ts
    - path: extensions/project.ts
      tools: [web_fetch, jira_get]
rooms:
  planning:
    stations:
      planner:
        instructions: roles/planner.md
  engineering:
    instructions: rooms/engineering.md
    stations:
      developer:
        instructions: roles/developer.md
        instances: 3
        isolation: worktree
      reviewer:
        model: \${REVIEW_MODEL}
        extensions: []
        isolation: worktree
      integrator:
        isolation: worktree
production_lines:
  feature:
    rejection_limit: 3
    verify: [npm, test]
    stages:
      - id: plan
        station: planning.planner
      - id: develop
        station: engineering.developer
        writing: true
      - id: review
        station: engineering.reviewer
        on_rejection: develop
      - id: integrate
        station: engineering.integrator
        approval: true
        on_rejection: develop
`;

const problemsOf = (text: string): ReadonlyArray<ConfigProblem> => {
  const result = decodeFactoryYaml(text);

  if (result._tag === "Valid") {throw new Error("expected the configuration to be rejected");}

  return result.problems;
};

describe("valid configuration", () => {
  test("the PRD example decodes and keeps its values", () => {
    const result = decodeFactoryYaml(prdExample);
    expect(result._tag).toBe("Valid");

    if (result._tag !== "Valid") {return;}

    expect(result.config.rooms["engineering"]?.stations["developer"]?.instances).toBe(3);
    expect(result.config.rooms["engineering"]?.stations["reviewer"]?.extensions).toEqual([]);
    expect(result.config.defaults?.extensions?.[1]).toEqual({
      path: "extensions/project.ts",
      tools: ["web_fetch", "jira_get"],
    });
  });

  test("omitted settings take their PRD §4 defaults", () => {
    const result = decodeFactoryYaml(minimal);
    expect(result._tag).toBe("Valid");

    if (result._tag !== "Valid") {return;}

    const { config } = result;
    expect(config.worktrees).toEqual({
      root: "~/worktrees",
      branch_pattern: "ticket/{ticket-id}-{slug}",
    });
    expect(config.knowledge).toEqual({ root: "knowledge" });
    expect([config.message_budget, config.delegation_depth_limit, config.recovery_limit]).toEqual([
      100, 2, 3,
    ]);
    expect(config.rooms["engineering"]?.stations["developer"]?.instances).toBe(1);
    const line = config.production_lines["feature"];
    expect(line?.rejection_limit).toBe(3);
    expect(line?.stages[0]).toMatchObject({ writing: true, approval: false });
  });
});

// Each row: the input, then the path and message of a problem it must report,
// and the 1-based line where the problem must be located.
const rejected: ReadonlyArray<[string, string, { path: string; message: RegExp; line: number }]> = [
  ["malformed YAML", "version: 1\nname: [unclosed\n", { path: "", message: /\]/, line: 3 }],
  ["multiple documents", `${minimal}---\nversion: 1\n`, { path: "", message: /MULTIPLE_DOCS/, line: 22 }],
  ["unresolved tag", minimal.replace("name: example-factory", "name: !secret x"), { path: "", message: /TAG_RESOLVE_FAILED/, line: 2 }],
  ["duplicate top-level key", `${minimal}name: other\n`, { path: "", message: /DUPLICATE_KEY/, line: 22 }],
  ["duplicate nested key", minimal.replace("        isolation: worktree\n", "        isolation: worktree\n        isolation: none\n"), { path: "", message: /DUPLICATE_KEY/, line: 12 }],
  ["unknown top-level key", `${minimal}colour: blue\n`, { path: "colour", message: /^Unknown key$/, line: 22 }],
  ["known P1 setting on_demand", minimal.replace("        isolation: worktree\n", "        isolation: worktree\n        on_demand: true\n"), { path: "rooms.engineering.stations.developer.on_demand", message: /^Unknown key$/, line: 12 }],
  ["room-level model override", minimal.replace("    stations:\n", "    model: a/b\n    stations:\n"), { path: "rooms.engineering.model", message: /^Unknown key$/, line: 9 }],
  ["recovery_limit on a line", minimal.replace("    stages:\n", "    recovery_limit: 3\n    stages:\n"), { path: "production_lines.feature.recovery_limit", message: /^Unknown key$/, line: 14 }],
  ["unsupported version", minimal.replace("version: 1", "version: 2"), { path: "version", message: /Unsupported version/, line: 1 }],
  ["version as a string", minimal.replace("version: 1", "version: '1'"), { path: "version", message: /Unsupported version/, line: 1 }],
  ["missing required key", minimal.replace("default_production_line: feature\n", ""), { path: "default_production_line", message: /Missing key/, line: 1 }],
  ["wrong type for name", minimal.replace("name: example-factory", "name: [a]"), { path: "name", message: /Expected string/, line: 2 }],
  ["empty name", minimal.replace("name: example-factory", "name: ''"), { path: "name", message: /length/, line: 2 }],
  ["non-integer instances", minimal.replace("isolation: worktree", "instances: 1.5"), { path: "rooms.engineering.stations.developer.instances", message: /integer/, line: 11 }],
  ["zero instances", minimal.replace("isolation: worktree", "instances: 0"), { path: "rooms.engineering.stations.developer.instances", message: /greater than 0/, line: 11 }],
  ["unknown isolation", minimal.replace("isolation: worktree", "isolation: sandbox"), { path: "rooms.engineering.stations.developer.isolation", message: /"none" \| "worktree"/, line: 11 }],
  ["negative message budget", `${minimal}message_budget: -1\n`, { path: "message_budget", message: /greater than 0/, line: 22 }],
  ["negative delegation depth", `${minimal}delegation_depth_limit: -1\n`, { path: "delegation_depth_limit", message: /greater than or equal to 0/, line: 22 }],
  ["zero rejection limit", minimal.replace("    stages:\n", "    rejection_limit: 0\n    stages:\n"), { path: "production_lines.feature.rejection_limit", message: /greater than 0/, line: 14 }],
  ["writing as a string", minimal.replace("writing: true", "writing: 'yes'"), { path: "production_lines.feature.stages.0.writing", message: /boolean/, line: 17 }],
  ["no stages", minimal.replace(/    stages:\n[\s\S]*$/, "    stages: []\n"), { path: "production_lines.feature.stages", message: /at least one stage/, line: 14 }],
  ["verify not a list", minimal.replace("    stages:\n", "    verify: npm test\n    stages:\n"), { path: "production_lines.feature.verify", message: /array/, line: 14 }],
  ["extension object missing tools", minimal.replace("isolation: worktree", "extensions: [{ path: x.ts }]"), { path: "rooms.engineering.stations.developer.extensions.0.tools", message: /Missing key/, line: 11 }],
  ["document is not a mapping", "- a\n- b\n", { path: "", message: /Expected object/, line: 1 }],
  ["empty document", "", { path: "", message: /Expected object/, line: 1 }],
];

describe("rejected configuration", () => {
  test.each(rejected)("%s", (_name, text, expected) => {
    const problems = problemsOf(text);

    const match = problems.find(
      (problem) => problem.path === expected.path && expected.message.test(problem.message),
    );

    expect(match, JSON.stringify(problems)).toBeDefined();
    expect(match?.line).toBe(expected.line);
  });
});
