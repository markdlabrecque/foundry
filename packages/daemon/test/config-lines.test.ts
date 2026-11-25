import { describe, expect, test } from "vitest";
import { decodeFactoryYaml } from "@foundry/daemon/config";

// Unit tier: production-line rules are pure checks on decoded config, so a
// table of YAML inputs through the decoder proves them without I/O.

/** A valid factory whose line satisfies every rule; cases edit its stages. */
const base = (stages: string, extra = ""): string => `version: 1
name: lines
repository:
  source: ../p
  default_branch: main
default_production_line: feature
rooms:
  planning:
    stations:
      planner: {}
  engineering:
    stations:
      developer:
        isolation: worktree
      integrator:
        isolation: worktree
production_lines:
  feature:
    verify: [npm, test]
${extra}    stages:
${stages}`;

const goodStages = `      - id: plan
        station: planning.planner
      - id: develop
        station: engineering.developer
        writing: true
      - id: integrate
        station: engineering.integrator
        approval: true
        on_rejection: develop
`;

test("a line meeting every rule is valid with no warnings", () => {
  const result = decodeFactoryYaml(base(goodStages));
  expect(result).toMatchObject({ _tag: "Valid", warnings: [] });
});

// Each row: name, YAML, then the path and message of a problem it must report
// and the 1-based line it must be located at.
const rejected: ReadonlyArray<[string, string, { path: string; message: RegExp; line: number }]> = [
  [
    "unknown default production line",
    base(goodStages).replace("default_production_line: feature", "default_production_line: hotfix"),
    { path: "default_production_line", message: /Unknown production line "hotfix"/, line: 6 },
  ],
  [
    "unknown station",
    base(goodStages.replace("planning.planner", "planning.architect")),
    { path: "production_lines.feature.stages.0.station", message: /Unknown station "planning.architect"/, line: 22 },
  ],
  [
    "station without a room",
    base(goodStages.replace("planning.planner", "planner")),
    { path: "production_lines.feature.stages.0.station", message: /Unknown station "planner"/, line: 22 },
  ],
  [
    "station in the wrong room",
    base(goodStages.replace("planning.planner", "engineering.planner")),
    { path: "production_lines.feature.stages.0.station", message: /Unknown station/, line: 22 },
  ],
  [
    "duplicate stage ID",
    base(goodStages.replace("id: plan", "id: develop")),
    { path: "production_lines.feature.stages.1.id", message: /Duplicate stage ID "develop"/, line: 23 },
  ],
  [
    "rejection route to an unknown stage",
    base(goodStages.replace("on_rejection: develop", "on_rejection: build")),
    { path: "production_lines.feature.stages.2.on_rejection", message: /"build" does not name an earlier stage/, line: 29 },
  ],
  [
    "rejection route to a later stage",
    base(goodStages.replace("        station: planning.planner\n", "        station: planning.planner\n        on_rejection: develop\n")),
    { path: "production_lines.feature.stages.0.on_rejection", message: /"develop" does not name an earlier stage/, line: 23 },
  ],
  [
    "rejection route to itself",
    base(goodStages.replace("        writing: true\n", "        writing: true\n        on_rejection: develop\n")),
    { path: "production_lines.feature.stages.1.on_rejection", message: /does not name an earlier stage/, line: 26 },
  ],
  [
    "writing stage on a non-worktree station",
    base(goodStages.replace("        station: planning.planner\n", "        station: planning.planner\n        writing: true\n")),
    { path: "production_lines.feature.stages.0.writing", message: /writing stage must use a worktree station/, line: 23 },
  ],
  [
    "final stage is writing",
    base(goodStages.replace("        approval: true\n", "        approval: true\n        writing: true\n")),
    { path: "production_lines.feature.stages.2.writing", message: /Final stage must not be a writing stage/, line: 29 },
  ],
  [
    "final stage on a non-worktree station",
    base(goodStages.replace("engineering.integrator", "planning.planner")),
    { path: "production_lines.feature.stages.2.station", message: /Final stage must use a worktree station/, line: 27 },
  ],
  [
    "final stage without approval",
    base(goodStages.replace("        approval: true\n", "")),
    { path: "production_lines.feature.stages.2.approval", message: /Final stage must require approval/, line: 26 },
  ],
  [
    "final stage without a rejection route",
    base(goodStages.replace("        on_rejection: develop\n", "")),
    { path: "production_lines.feature.stages.2.on_rejection", message: /Final stage must name an earlier writing stage/, line: 26 },
  ],
  [
    "final stage routing to a non-writing stage",
    base(goodStages.replace("on_rejection: develop", "on_rejection: plan")),
    { path: "production_lines.feature.stages.2.on_rejection", message: /"plan" is not writing/, line: 29 },
  ],
  [
    "single-stage line cannot meet the final-stage contract",
    base(`      - id: only
        station: engineering.integrator
        approval: true
`),
    { path: "production_lines.feature.stages.0.on_rejection", message: /Final stage must name an earlier writing stage/, line: 21 },
  ],
];

describe("rejected production lines", () => {
  test.each(rejected)("%s", (_name, text, expected) => {
    const result = decodeFactoryYaml(text);
    if (result._tag === "Valid") throw new Error("expected the configuration to be rejected");
    const match = result.problems.find(
      (problem) => problem.path === expected.path && expected.message.test(problem.message),
    );
    expect(match, JSON.stringify(result.problems)).toBeDefined();
    expect(match?.line).toBe(expected.line);
  });
});

test("a line with no verify command is warned about, not rejected", () => {
  const result = decodeFactoryYaml(base(goodStages).replace("    verify: [npm, test]\n", ""));
  expect(result._tag).toBe("Valid");
  if (result._tag !== "Valid") return;
  expect(result.warnings).toEqual([
    expect.objectContaining({ path: "production_lines.feature", message: expect.stringMatching(/No verify command/), line: 19 }),
  ]);
});
