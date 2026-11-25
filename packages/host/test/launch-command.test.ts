import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import {
  FIXED_TOOLS,
  buildLaunchCommand,
  resolvePiExecutable,
  type LaunchInputs,
  type PiExecutable,
} from "@foundry/host";

// Unit tier: the launch command is a pure mapping, so Pi's own argument parser
// proves how Pi 1.6.0 reads it without spawning a process.

const pi: PiExecutable = { command: "/opt/pi/bin/pi", args: [] };

function inputs(overrides: Partial<LaunchInputs> = {}): LaunchInputs {
  return {
    model: "faux/scripted",
    skills: ["/factory/skills/project/SKILL.md"],
    extensions: [
      { path: "/factory/extensions/audit.ts", tools: [] },
      { path: "/factory/extensions/project.ts", tools: ["web_fetch", "jira_get"] },
    ],
    foundryExtension: "/opt/foundry/extension/dist/index.js",
    slotDir: "/state/slots/factory-1/developer-1",
    factoryId: "factory-1",
    slotId: "developer/1",
    launchId: "launch-7",
    ...overrides,
  };
}

test("maps effective station inputs literally onto Pi's RPC argv", () => {
  const launch = buildLaunchCommand(inputs(), pi, {});
  const parsed = parseArgs([...launch.args]);

  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.unknownFlags.size).toBe(0);
  expect(parsed.messages).toEqual([]);
  expect(parsed.fileArgs).toEqual([]);
  expect(parsed.mode).toBe("rpc");
  expect(parsed.model).toBe("faux/scripted");
  expect(parsed.provider).toBeUndefined();
  expect(parsed.tools).toEqual([...FIXED_TOOLS, "web_fetch", "jira_get"]);
  expect(parsed.extensions).toEqual([
    "/opt/foundry/extension/dist/index.js",
    "/factory/extensions/audit.ts",
    "/factory/extensions/project.ts",
  ]);
  expect(parsed.skills).toEqual(["/factory/skills/project/SKILL.md"]);
  expect(launch.command).toBe("/opt/pi/bin/pi");
  expect(launch.cwd).toBe("/state/slots/factory-1/developer-1");
});

test("suppresses every inherited global and repository resource", () => {
  const parsed = parseArgs([...buildLaunchCommand(inputs(), pi, {}).args]);

  expect(parsed).toMatchObject({
    noExtensions: true,
    noMcp: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    projectTrustOverride: false,
  });
  expect(parsed.promptTemplates).toBeUndefined();
  expect(parsed.themes).toBeUndefined();
});

test("cleared skill and extension lists leave only the Foundry extension and fixed tools", () => {
  const parsed = parseArgs([...buildLaunchCommand(inputs({ skills: [], extensions: [] }), pi, {}).args]);

  expect(parsed.extensions).toEqual(["/opt/foundry/extension/dist/index.js"]);
  expect(parsed.skills).toBeUndefined();
  expect(parsed.tools).toEqual([...FIXED_TOOLS]);
  expect(parsed.noSkills).toBe(true);
  expect(parsed.noExtensions).toBe(true);
});

test("passes the host environment unfiltered and launch identity overrides inherited values", () => {
  const hostEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "test-key",
    PI_CODING_AGENT_DIR: "/tmp/agent",
    FOUNDRY_SLOT: "stale/9",
    UNSET: undefined,
  };
  const launch = buildLaunchCommand(inputs(), pi, hostEnv);

  expect(launch.env).toEqual({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "test-key",
    PI_CODING_AGENT_DIR: "/tmp/agent",
    FOUNDRY_FACTORY_ID: "factory-1",
    FOUNDRY_SLOT: "developer/1",
    FOUNDRY_LAUNCH_ID: "launch-7",
  });
});

test("keeps the executable's leading arguments before Pi's own", () => {
  const launch = buildLaunchCommand(inputs(), { command: "/usr/bin/node", args: ["/pi/rpc-entry.js"] }, {});

  expect(launch.command).toBe("/usr/bin/node");
  expect(launch.args.slice(0, 3)).toEqual(["/pi/rpc-entry.js", "--mode", "rpc"]);
});

test.each([
  ["a model that reads as a flag", { model: "--help" }],
  ["an empty model", { model: "" }],
  ["a relative slot folder", { slotDir: "slots/developer-1" }],
  ["a relative skill", { skills: ["skills/SKILL.md"] }],
  ["a relative extension", { extensions: [{ path: "ext.ts", tools: [] }] }],
  ["a tool name that would split the list", { extensions: [{ path: "/e.ts", tools: ["a,b"] }] }],
  ["a tool pattern", { extensions: [{ path: "/e.ts", tools: ["web_*"] }] }],
  ["an empty launch ID", { launchId: "" }],
])("refuses %s", (_label, overrides: Partial<LaunchInputs>) => {
  expect(() => buildLaunchCommand(inputs(overrides), pi, {})).toThrow();
});

test("FOUNDRY_PI_BIN overrides the pinned Pi, otherwise the pinned RPC entry runs under this Node", () => {
  expect(resolvePiExecutable({ FOUNDRY_PI_BIN: "/tmp/stub-pi" })).toEqual({ command: "/tmp/stub-pi", args: [] });

  const pinned = resolvePiExecutable({});
  expect(pinned.command).toBe(process.execPath);
  expect(pinned.args).toHaveLength(1);
  expect(pinned.args[0]).toMatch(/pi-coding-agent[\\/]dist[\\/]bundle[\\/]rpc-entry\.js$/);
  expect(existsSync(pinned.args[0]!)).toBe(true);
});
