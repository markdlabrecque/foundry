import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { branchNameProblem, isUrlSource, validateFactoryYaml } from "@foundry/daemon/config";
import type { ConfigProblem } from "@foundry/daemon/config";

// Tier: integration on the real filesystem (one boundary), one disposable
// directory shared by every case. The checks only stat files, so each case is
// milliseconds; pure rules (branch names, URL form) are plain unit tables.

// Created in beforeAll, not at import, so a directory exists only in a run
// that also reaches afterAll and removes it.
let root = "";
let factoryDir = "";
let home = "";
let yamlFile = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "foundry-offline-"));
  factoryDir = join(root, "factory");
  home = join(root, "home");
  yamlFile = join(factoryDir, "factory.yaml");

  for (const dir of ["repo", "factory/roles", "factory/skills/project", "factory/extensions", "factory/a-dir", "home"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  for (const file of ["factory.md", "roles/developer.md", "skills/project/SKILL.md", "extensions/audit.ts", "extensions/project.ts", "a-file"]) {
    writeFileSync(join(factoryDir, file), "x");
  }

  // Files under the test home prove `~/` resolves there and not elsewhere.
  writeFileSync(join(home, "shared.md"), "x");
  writeFileSync(join(home, "a-file"), "x");
});

afterAll(() => {
  if (root !== "") {rmSync(root, { recursive: true, force: true });}
});

/** Every configured file exists; relative paths resolve from the factory directory. */
const valid = `version: 1
name: example-factory
repository:
  source: ../repo
  default_branch: main
default_production_line: feature
worktrees:
  root: ~/worktrees
  after_create: [./scripts/setup-worktree, --flag]
knowledge:
  root: knowledge
defaults:
  instructions: factory.md
  skills: [skills/project/SKILL.md]
  extensions:
    - extensions/audit.ts
    - path: extensions/project.ts
      tools: [web_fetch]
rooms:
  engineering:
    stations:
      developer:
        instructions: roles/developer.md
        isolation: worktree
production_lines:
  feature:
    verify: [npm, test]
    stages:
      - id: develop
        station: engineering.developer
        writing: true
      - id: integrate
        station: engineering.developer
        approval: true
        on_rejection: develop
`;

const validate = (text: string) => validateFactoryYaml(text, { yamlFile, home });

const problemsOf = (text: string): ReadonlyArray<ConfigProblem> => {
  const result = validate(text);

  if (result._tag === "Valid") {throw new Error("expected the configuration to be rejected");}

  return result.problems;
};

/** Every entry beneath the disposable root, to prove validation adds nothing. */
const tree = (dir: string): Array<string> =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

describe("accepted", () => {
  test.each([
    ["the base factory", () => valid],
    ["an absolute source", () => valid.replace("../repo", join(root, "repo"))],
    ["an https source, not contacted", () => valid.replace("../repo", "https://git.invalid/o/r.git")],
    ["an ssh URL source", () => valid.replace("../repo", "ssh://git@git.invalid/o/r.git")],
    ["an scp-like source", () => valid.replace("../repo", "git@git.invalid:o/r.git")],
    ["a nested default branch", () => valid.replace("default_branch: main", "default_branch: release/2.x")],
    ["a pattern with only {ticket-id}", () => valid.replace("  root: ~/worktrees\n", "  root: ~/worktrees\n  branch_pattern: 'work/{ticket-id}'\n")],
    ["instructions under ~ that exist only in home", () => valid.replace("instructions: factory.md", "instructions: ~/shared.md")],
    ["a command argument naming a missing file", () => valid.replace("[npm, test]", "[./missing-script, ../nope]")],
  ])("%s", (_name, text) => {
    const result = validate(text());
    expect(result._tag, JSON.stringify(result)).toBe("Valid");
  });
});

// Each row: the input, then the path and message of a problem it must report,
// and the 1-based line where it must be located.
const rejected: ReadonlyArray<[string, string, { path: string; message: RegExp; line: number }]> = [
  ["missing default instructions", valid.replace("instructions: factory.md", "instructions: gone.md"), { path: "defaults.instructions", message: /Configured file not found: .*factory\/gone\.md$/, line: 13 }],
  ["missing station instructions", valid.replace("roles/developer.md", "roles/gone.md"), { path: "rooms.engineering.stations.developer.instructions", message: /not found/, line: 23 }],
  ["missing skill", valid.replace("skills/project/SKILL.md", "skills/gone/SKILL.md"), { path: "defaults.skills.0", message: /not found/, line: 14 }],
  ["missing hooks-only extension", valid.replace("- extensions/audit.ts", "- extensions/gone.ts"), { path: "defaults.extensions.0", message: /not found/, line: 16 }],
  ["missing extension with tools", valid.replace("path: extensions/project.ts", "path: extensions/gone.ts"), { path: "defaults.extensions.1.path", message: /not found/, line: 17 }],
  ["instructions naming a directory", valid.replace("instructions: factory.md", "instructions: a-dir"), { path: "defaults.instructions", message: /not a file/, line: 13 }],
  ["missing local source", valid.replace("../repo", "../gone"), { path: "repository.source", message: /Repository source not found/, line: 4 }],
  ["local source that is a file", valid.replace("../repo", "a-file"), { path: "repository.source", message: /not a directory/, line: 4 }],
  ["URL with an unsupported scheme", valid.replace("../repo", "ftp://host/r.git"), { path: "repository.source", message: /Unsupported repository URL scheme/, line: 4 }],
  ["URL with no host", valid.replace("../repo", "ssh:///r.git"), { path: "repository.source", message: /no host/, line: 4 }],
  ["URL with no repository path", valid.replace("../repo", "https://git.invalid/"), { path: "repository.source", message: /no repository path/, line: 4 }],
  ["invalid default branch", valid.replace("default_branch: main", "default_branch: 'a..b'"), { path: "repository.default_branch", message: /Invalid branch name/, line: 5 }],
  ["unknown branch placeholder", valid.replace("  root: ~/worktrees\n", "  root: ~/worktrees\n  branch_pattern: 't/{id}'\n"), { path: "worktrees.branch_pattern", message: /Unknown placeholder \{id\}/, line: 9 }],
  ["branch pattern without {ticket-id}", valid.replace("  root: ~/worktrees\n", "  root: ~/worktrees\n  branch_pattern: 't/{slug}'\n"), { path: "worktrees.branch_pattern", message: /must contain \{ticket-id\}/, line: 9 }],
  ["branch pattern forming an invalid name", valid.replace("  root: ~/worktrees\n", "  root: ~/worktrees\n  branch_pattern: 't {ticket-id}'\n"), { path: "worktrees.branch_pattern", message: /valid branch name/, line: 9 }],
  ["instructions under ~ missing from home", valid.replace("instructions: factory.md", "instructions: ~/factory.md"), { path: "defaults.instructions", message: /not found: .*home\/factory\.md$/, line: 13 }],
  ["worktree root under ~ that is a file", valid.replace("root: ~/worktrees", "root: ~/a-file"), { path: "worktrees.root", message: /not a directory: .*home\/a-file$/, line: 8 }],
  ["worktree root that is a file", valid.replace("root: ~/worktrees", "root: ../factory/a-file"), { path: "worktrees.root", message: /not a directory/, line: 8 }],
  ["knowledge root that is a file", valid.replace("root: knowledge", "root: a-file"), { path: "knowledge.root", message: /not a directory/, line: 11 }],
  ["empty verify", valid.replace("[npm, test]", "[]"), { path: "production_lines.feature.verify", message: /Command must not be empty/, line: 27 }],
  ["empty after_create", valid.replace("[./scripts/setup-worktree, --flag]", "[]"), { path: "worktrees.after_create", message: /Command must not be empty/, line: 9 }],
  ["empty before_remove", valid.replace("knowledge:\n", "  before_remove: []\nknowledge:\n"), { path: "worktrees.before_remove", message: /Command must not be empty/, line: 10 }],
  ["empty command program", valid.replace("[npm, test]", "['', test]"), { path: "production_lines.feature.verify.0", message: /program must not be empty/, line: 27 }],
];

describe("rejected", () => {
  test.each(rejected)("%s", (_name, text, expected) => {
    const problems = problemsOf(text);

    const match = problems.find(
      (problem) => problem.path === expected.path && expected.message.test(problem.message),
    );

    expect(match, JSON.stringify(problems)).toBeDefined();
    expect(match?.line).toBe(expected.line);
  });

  test("structural problems are reported before any file is checked", () => {
    const problems = problemsOf(valid.replace("version: 1", "version: 2").replace("factory.md", "gone.md"));
    expect(problems.map((p) => p.path)).toEqual(["version"]);
  });
});

// Root can read a mode-000 file, so the check cannot be observed there.
test.skipIf(process.getuid?.() === 0)("an unreadable configured file is rejected", () => {
  const locked = join(factoryDir, "locked.md");
  writeFileSync(locked, "x", { mode: 0o000 });

  try {
    const problems = problemsOf(valid.replace("instructions: factory.md", "instructions: locked.md"));
    expect(problems).toContainEqual(
      expect.objectContaining({ path: "defaults.instructions", message: expect.stringMatching(/not readable/), line: 13 }),
    );
  } finally {
    rmSync(locked, { force: true });
  }
});

test("validation creates no directory and runs no command", () => {
  // Hooks and verify point at a script that would leave a marker if run, and
  // the worktree and knowledge roots do not exist yet.
  const marker = join(root, "ran");
  const script = join(factoryDir, "mark.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

  const text = valid
    .replace("[./scripts/setup-worktree, --flag]", `[${script}]`)
    .replace("[npm, test]", `[${script}]`)
    .replace("root: ~/worktrees", "root: ~/not-yet/worktrees")
    .replace("root: knowledge", "root: not-yet-knowledge")
    .replace("instructions: factory.md", "instructions: gone.md");

  const before = tree(root);

  const problems = problemsOf(text);

  expect(problems.map((p) => p.path)).toEqual(["defaults.instructions"]);
  expect(validate(text.replace("gone.md", "factory.md"))._tag).toBe("Valid");
  expect(tree(root)).toEqual(before);
});

describe("branch names", () => {
  test.each([
    ["main", undefined],
    ["release/2.x", undefined],
    ["@", /"@"/],
    ["HEAD", /"HEAD"/],
    ["-x", /starts with "-"/],
    ["a/", /"\/"/],
    ["a//b", /"\/\/"/],
    ["a.", /ends with "."/],
    ["a..b", /".."/],
    ["a@{b", /"@\{"/],
    ["a b", /forbidden/],
    ["a~b", /forbidden/],
    ["a:b", /forbidden/],
    ["a/.b", /starting with "."/],
    ["a.lock", /".lock"/],
  ])("%s", (name, expected) => {
    const reason = branchNameProblem(name);

    if (expected === undefined) {expect(reason).toBeUndefined();}
    else {expect(reason).toMatch(expected);}
  });
});

describe("source form", () => {
  test.each([
    ["https://h/o/r.git", true],
    ["git@h:o/r.git", true],
    ["h:o/r", true],
    ["../repo", false],
    ["./repo:x", false],
    ["/abs/repo", false],
    ["repo", false],
  ])("%s is a URL: %s", (source, expected) => {
    expect(isUrlSource(source)).toBe(expected);
  });
});
