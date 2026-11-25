import { execFileSync } from "node:child_process";
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
  try {
    const stdout = execFileSync(process.execPath, [main, "validate", file], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, stdout: stdout.replaceAll(file, "F"), stderr: "" };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout.replaceAll(file, "F"), stderr: e.stderr.replaceAll(file, "F") };
  }
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
      s: {}
production_lines:
  f:
    stages:
      - id: a
        station: r.s
`;

test("foundry validate accepts a valid factory with exit 0", () => {
  const result = run(valid);
  expect(result).toMatchObject({ status: 0, stdout: 'F: factory "smoke" is valid\n' });
});

test("foundry validate reports the location of each problem and exits 1", () => {
  const result = run(valid.replace("version: 1", "version: 2").replace("      s: {}", "      s:\n        on_demand: true"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("F:1:10: version: Unsupported version");
  expect(result.stderr).toContain("F:11:9: rooms.r.stations.s.on_demand: Unknown key");
});

test("foundry validate reports a duplicate key at its line", () => {
  const result = run(`${valid}name: again\n`);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^F:16:1: .*DUPLICATE_KEY/m);
});

test("foundry validate reports a missing configured file at its setting", () => {
  const result = run(valid.replace("      s: {}", "      s:\n        instructions: missing.md"));
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^F:11:23: rooms\.r\.stations\.s\.instructions: Configured file not found: .*missing\.md$/m);
});
