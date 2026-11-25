// Integration tier: one real filesystem boundary, exercised against disposable
// temp-dir fixtures. No Pi process, network or operator state is involved.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverRepositoryContext } from "@foundry/daemon";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Builds a disposable tree from a map of relative path to file content. */
async function makeTree(files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "foundry-repo-context-"));
  fixtures.push(base);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), content);
  }
  return base;
}

const skill = (description: string, extra = "", body = "SKILL BODY MUST NOT BE INDEXED"): string =>
  `---\ndescription: ${description}\n${extra}---\n${body}\n`;

describe("context file precedence", () => {
  test.each([
    {
      name: "AGENTS.override.md beats AGENTS.md and CLAUDE.md",
      files: { "AGENTS.override.md": "override", "AGENTS.md": "agents", "CLAUDE.md": "claude" },
      expected: { path: "AGENTS.override.md", content: "override" },
    },
    {
      name: "AGENTS.md beats CLAUDE.md",
      files: { "AGENTS.md": "agents", "CLAUDE.md": "claude" },
      expected: { path: "AGENTS.md", content: "agents" },
    },
    {
      name: "CLAUDE.md is used alone",
      files: { "CLAUDE.md": "\uFEFFclaude" },
      expected: { path: "CLAUDE.md", content: "claude" },
    },
  ])("$name", async ({ files, expected }) => {
    const root = await makeTree(files);
    expect((await discoverRepositoryContext(root)).contextFile).toEqual(expected);
  });

  test("a directory named like a context file is skipped", async () => {
    const root = await makeTree({ "AGENTS.override.md/x": "", "AGENTS.md": "agents" });
    expect((await discoverRepositoryContext(root)).contextFile).toEqual({ path: "AGENTS.md", content: "agents" });
  });
});

test("includes only the context file, append-system text and skill headers", async () => {
  const root = await makeTree({
    "AGENTS.md": "repo rules",
    ".pi/APPEND_SYSTEM.md": "append me",
    ".pi/SYSTEM.md": "EXCLUDED system",
    ".pi/settings.json": '{"model":"EXCLUDED"}',
    ".pi/extensions/ext/index.ts": "EXCLUDED extension",
    ".pi/prompts/review.md": "---\ndescription: EXCLUDED prompt\n---\n",
    ".pi/skills/alpha/SKILL.md": skill("Alpha skill."),
    ".pi/skills/hidden/SKILL.md": skill("Hidden.", "disable-model-invocation: true\n"),
    ".pi/skills/no-description/SKILL.md": "---\nname: no-description\n---\nbody\n",
    ".pi/skills/.dot/SKILL.md": skill("Dot dir."),
    ".pi/skills/node_modules/dep/SKILL.md": skill("Dependency."),
    ".pi/skills/.gitignore": "ignored/\n",
    ".pi/skills/ignored/SKILL.md": skill("Ignored."),
    ".pi/skills/alpha/references/nested/SKILL.md": skill("Inside a skill root."),
  });

  const context = await discoverRepositoryContext(root);

  expect(context).toEqual({
    worktreeRoot: root,
    contextFile: { path: "AGENTS.md", content: "repo rules" },
    appendSystem: { path: ".pi/APPEND_SYSTEM.md", content: "append me" },
    skills: [{ name: "alpha", description: "Alpha skill.", path: ".pi/skills/alpha/SKILL.md" }],
  });
  expect(JSON.stringify(context)).not.toMatch(/EXCLUDED|SKILL BODY/);
});

test("indexes both skill directories deterministically, .pi/skills winning a name collision", async () => {
  const root = await makeTree({
    ".agents/skills/zeta/SKILL.md": skill("Zeta."),
    ".agents/skills/shared/SKILL.md": skill("Agents copy."),
    ".agents/skills/group/beta/SKILL.md": skill("Beta, nested."),
    ".agents/skills/top-level.md": skill("Root .md is not a skill under .agents."),
    ".agents/skills/group/loose.md": skill("Nested .md is a skill under .agents."),
    ".pi/skills/shared/SKILL.md": skill("Pi copy."),
    ".pi/skills/standalone.md": skill("Root .md is a skill under .pi.", "name: standalone\n"),
    ".pi/skills/renamed/SKILL.md": skill("Declared name.", "name: custom-name\n"),
    ".pi/skills/masked/SKILL.md": skill("Hidden, still claims its name.", "disable-model-invocation: true\n"),
    ".agents/skills/masked/SKILL.md": skill("MASKED: must not show through."),
  });

  const first = await discoverRepositoryContext(root);

  expect(first.skills).toEqual([
    { name: "beta", description: "Beta, nested.", path: ".agents/skills/group/beta/SKILL.md" },
    { name: "custom-name", description: "Declared name.", path: ".pi/skills/renamed/SKILL.md" },
    { name: "group", description: "Nested .md is a skill under .agents.", path: ".agents/skills/group/loose.md" },
    { name: "shared", description: "Pi copy.", path: ".pi/skills/shared/SKILL.md" },
    { name: "standalone", description: "Root .md is a skill under .pi.", path: ".pi/skills/standalone.md" },
    { name: "zeta", description: "Zeta.", path: ".agents/skills/zeta/SKILL.md" },
  ]);
  expect(await discoverRepositoryContext(root)).toEqual(first);
});

test("discovery stops at the worktree root", async () => {
  const outer = await makeTree({
    "AGENTS.md": "PARENT context",
    ".pi/APPEND_SYSTEM.md": "PARENT append",
    ".agents/skills/parent-skill/SKILL.md": skill("PARENT skill."),
    "elsewhere/escaped/SKILL.md": skill("ESCAPED skill."),
    "elsewhere/CLAUDE.md": "ESCAPED context",
    "repo/.agents/skills/inside/SKILL.md": skill("Inside."),
    "repo/.agents/skills/kept/SKILL.md": skill("Kept."),
    "elsewhere/gitignore": "kept/\n",
  });
  const root = join(outer, "repo");
  await symlink(join(outer, "elsewhere/gitignore"), join(root, ".agents/skills/.gitignore"));
  await symlink(join(outer, "elsewhere/escaped"), join(root, ".agents/skills/escaped"));
  await symlink(join(outer, "elsewhere/CLAUDE.md"), join(root, "CLAUDE.md"));

  const context = await discoverRepositoryContext(root);

  expect(context.contextFile).toBeNull();
  expect(context.appendSystem).toBeNull();
  expect(context.skills).toEqual([
    { name: "inside", description: "Inside.", path: ".agents/skills/inside/SKILL.md" },
    { name: "kept", description: "Kept.", path: ".agents/skills/kept/SKILL.md" },
  ]);
});
