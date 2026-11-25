import { describe, expect, test } from "vitest";
import { decodeFactoryYaml } from "@foundry/daemon/config";

/** A factory with the given `rooms:` block; the line references a station kept valid in every case. */
const factory = (rooms: string): string => `version: 1
name: example-factory
repository:
  source: ../example-project
  default_branch: main
default_production_line: feature
rooms:
${rooms}production_lines:
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

// Rooms begin on line 8.
const pool = `  planning:
    stations:
      planner: {}
  engineering:
    stations:
      developer:
        instances: 3
        isolation: worktree
      reviewer-2: {}
`;

describe("valid names", () => {
  test("a pooled station and several rooms with distinct grammatical names pass", () => {
    const result = decodeFactoryYaml(factory(pool));
    expect(result._tag, JSON.stringify(result)).toBe("Valid");
  });
});

// Each row: the rooms block, then the path, message and 1-based line of a problem it must report.
const rejected: ReadonlyArray<[string, string, { path: string; message: RegExp; line: number }]> = [
  [
    "duplicate station across rooms",
    `${pool}  review:\n    stations:\n      planner: {}\n`,
    { path: "rooms.review.stations.planner", message: /already used by planning\.planner/, line: 19 },
  ],
  [
    "station named like a room",
    `${pool}  review:\n    stations:\n      planning: {}\n`,
    { path: "rooms.review.stations.planning", message: /share one namespace/, line: 19 },
  ],
  [
    "station named like its own room",
    pool.replace("reviewer-2: {}", "engineering: {}"),
    { path: "rooms.engineering.stations.engineering", message: /share one namespace/, line: 16 },
  ],
  ["reserved room packs", pool.replace("planning:", "packs:"), { path: "rooms.packs", message: /"packs" is reserved/, line: 8 }],
  ["reserved station lore", pool.replace("planner:", "lore:"), { path: "rooms.planning.stations.lore", message: /"lore" is reserved/, line: 10 }],
  ["reserved station factory", pool.replace("reviewer-2:", "factory:"), { path: "rooms.engineering.stations.factory", message: /"factory" is reserved/, line: 16 }],
  ["uppercase room", pool.replace("planning:", "Planning:"), { path: "rooms.Planning", message: /lowercase letters, digits and hyphens/, line: 8 }],
  ["station starting with a digit", pool.replace("planner:", "2planner:"), { path: "rooms.planning.stations.2planner", message: /starting with a letter/, line: 10 }],
  ["station with an underscore", pool.replace("planner:", "plan_ner:"), { path: "rooms.planning.stations.plan_ner", message: /lowercase letters, digits and hyphens/, line: 10 }],
  ["station with a dot", pool.replace("planner:", "'plan.ner':"), { path: "rooms.planning.stations.plan.ner", message: /lowercase letters, digits and hyphens/, line: 10 }],
  ["empty room name", pool.replace("planning:", "'':"), { path: "rooms.", message: /lowercase letters, digits and hyphens/, line: 8 }],
];

describe("rejected names", () => {
  test.each(rejected)("%s", (_name, rooms, expected) => {
    const result = decodeFactoryYaml(factory(rooms));
    expect(result._tag).toBe("Invalid");
    if (result._tag !== "Invalid") return;
    const match = result.problems.find(
      (problem) => problem.path === expected.path && expected.message.test(problem.message),
    );
    expect(match, JSON.stringify(result.problems)).toBeDefined();
    expect(match?.line).toBe(expected.line);
  });
});
