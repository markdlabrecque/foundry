import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";

// CLI smoke: one run of the built `foundry` binary per outcome proves the
// command wiring, the exit code and that problems carry a file:line:column.
// Decoding logic itself is covered by the daemon's unit table.
const require = createRequire(import.meta.url);
const main = join(dirname(require.resolve("@foundry/cli")), "main.js");
const dir = mkdtempSync(join(tmpdir(), "foundry-validate-"));
mkdirSync(join(dir, "repo"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (yaml: string): { status: number; stdout: string; stderr: string } => {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, yaml);
  const result = spawnSync(process.execPath, [main, "validate", file], { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout.replaceAll(file, "F"),
    stderr: result.stderr.replaceAll(file, "F"),
  };
};

const valid = `version: 1
name: smoke
repository:
  source: ./repo
  default_branch: main
default_production_line: f
rooms:
  r:
    stations:
      s: { isolation: worktree, model: p/m }
production_lines:
  f:
    verify: [npm, test]
    stages:
      - id: a
        station: r.s
        writing: true
      - id: b
        station: r.s
        approval: true
        on_rejection: a
`;

test("foundry validate accepts a valid factory with exit 0", () => {
  const result = run(valid);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^F: factory "smoke" is valid\n/);
  expect(result.stderr).toBe("");
});

test("foundry validate prints each station's Tool Set with the source of every tool", () => {
  const station = "      s: { isolation: worktree, model: p/m }";
  expect(valid).toContain(station);
  const result = run(
    valid.replace(station, "      s:\n        isolation: worktree\n        model: p/m\n        extensions:\n          - ext/hooks.ts\n          - { path: ext/tools.ts, tools: [web_fetch] }"),
  );
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines[1]).toBe("Tool Set for r.s (13 tools):");
  expect(lines).toContainEqual(expect.stringMatching(/^  read +Pi built-in$/));
  expect(lines).toContainEqual(expect.stringMatching(/^  agent_message +Foundry extension$/));
  expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^  web_fetch +extension ${join(dir, "ext/tools.ts")}$`)));
  expect(lines.at(-1)).toMatch(/registers them is not checked/);
});

test("foundry validate reports the location of each problem and exits 1", () => {
  const result = run(valid.replace("version: 1", "version: 2").replace("      s: { isolation: worktree, model: p/m }", "      s:\n        isolation: worktree\n        on_demand: true"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("F:1:10: version: Unsupported version");
  expect(result.stderr).toContain("F:12:9: rooms.r.stations.s.on_demand: Unknown key");
});

test("foundry validate reports a duplicate key at its line", () => {
  const result = run(`${valid}name: again\n`);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^F:22:1: .*DUPLICATE_KEY/m);
});

test("foundry validate prints a missing verify as a warning and still exits 0", () => {
  const result = run(valid.replace("    verify: [npm, test]\n", ""));
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^F: factory "smoke" is valid\n/);
  expect(result.stderr).toMatch(/^F:13:5: production_lines\.f: No verify command.*\(warning\)$/m);
});

test("foundry validate reports an offline-check failure at its setting", () => {
  const result = run(valid.replace("      s: { isolation: worktree, model: p/m }", "      s:\n        isolation: worktree\n        model: p/m\n        instructions: missing.md"));
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^F:13:23: rooms\.r\.stations\.s\.instructions: Configured file not found: .*missing\.md$/m);
});

test("foundry validate reports a station-resolution failure at its setting", () => {
  const result = run(valid.replace("      s: { isolation: worktree, model: p/m }", "      s:\n        isolation: worktree\n        model: ${FOUNDRY_TEST_UNSET_MODEL}"));
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^F:12:\d+: rooms\.r\.stations\.s\.model: Model variable FOUNDRY_TEST_UNSET_MODEL is not set$/m);
});
