// Unit tier: real loader registration shape, no SDK bootstrap or process.
import { expect, test } from "vitest";
import { agentToolCollisions, decodeStartupDiagnostic } from "../src/sdk-diagnostic.js";

const extension = (path: string, names: Array<string>) => ({ path, tools: new Map(names.map((name) => [name, {}])) });

test("collisions retain actual duplicate agent registrations, not guessed loader error text", () => {
  const collisions = agentToolCollisions([
    extension("/foundry.js", ["agent_message"]), extension("/project.ts", ["agent_message", "custom"]),
  ]);

  expect(collisions).toEqual([{ name: "agent_message", sources: ["/foundry.js", "/project.ts"] }]);
  expect(agentToolCollisions([extension("/project.ts", ["read", "custom"])])).toEqual([]);
  expect(agentToolCollisions([extension("/project.ts", ["agent_message"])] )).toEqual([]);
  const diagnostic = { version: 1, kind: "agent_tool_collision", collisions };
  expect(decodeStartupDiagnostic(JSON.stringify(diagnostic))).toEqual(diagnostic);
});

test("unrelated errors, malformed, oversized or non-agent evidence is not a collision diagnostic", () => {
  for (const value of ["SDK extension load failed", "{}", "x".repeat(65_537), JSON.stringify({ version: 1, kind: "agent_tool_collision", collisions: [{ name: "read", sources: ["/a", "/b"] }] })]) {
    expect(decodeStartupDiagnostic(value)).toBeUndefined();
  }
});
