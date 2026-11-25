/**
 * Repository Context discovery (PRD §5.5).
 *
 * Workers launch outside the repository, so the daemon reproduces as text what
 * Pi 1.6.0 would have discovered had it been launched at the worktree root:
 *
 * - the context file at the worktree root, following Pi's override rule;
 * - `.pi/APPEND_SYSTEM.md`;
 * - an index of the repository's skills from `.pi/skills` and `.agents/skills`
 *   (name, description and path only; the worker reads bodies on demand).
 *
 * Nothing else is read: no extensions, prompt templates, settings, packages,
 * MCP servers or `.pi/SYSTEM.md`, and nothing from the operator's agent
 * directory. Discovery stops at the worktree root: no ancestor directories are
 * consulted, and a symlink whose target resolves outside the root is treated
 * as absent.
 *
 * The rules mirror these Pi 1.6.0 sources; re-check them on a Pi upgrade:
 * - `dist/core/resource-loader.js` `loadContextFileFromDir` (context file order)
 *   and `discoverAppendSystemPromptFile`;
 * - `dist/core/package-manager.js` `collectSkillEntries` (skill file collection);
 * - `dist/core/skills.js` `loadSkillFromFile`, `loadSkills` (first name wins)
 *   and `formatSkillsForPrompt` (hidden skills left out);
 * - `dist/utils/frontmatter.js` `parseFrontmatter`.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { parse as parseYaml } from "yaml";
import { Schema } from "effect";

/** A file reproduced verbatim, with its path relative to the worktree root. */
export interface RepositoryContextFile {
  /** POSIX path relative to the worktree root. */
  readonly path: string;
  /** File content with any byte-order mark removed. */
  readonly content: string;
}

/** One entry of the skill index. The skill body is never included. */
export interface SkillHeader {
  readonly name: string;
  readonly description: string;
  /** POSIX path of the skill file, relative to the worktree root. */
  readonly path: string;
}

export interface RepositoryContext {
  /** Absolute path of the worktree root that was searched. */
  readonly worktreeRoot: string;
  /** `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` at the root, by Pi's override rule. */
  readonly contextFile: RepositoryContextFile | null;
  /** `.pi/APPEND_SYSTEM.md`. */
  readonly appendSystem: RepositoryContextFile | null;
  /** Skill headers, sorted by name. */
  readonly skills: ReadonlyArray<SkillHeader>;
}

/** Pi 1.6.0's candidate order; the first regular file wins. */
const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

/** Pi's two skill layouts: `.pi/skills` takes root-level `.md` files, `.agents/skills` only nested ones. */
type SkillDirMode = "pi" | "agents";

const SKILL_DIRS: ReadonlyArray<{ readonly path: string; readonly mode: SkillDirMode }> = [
  { path: join(".pi", "skills"), mode: "pi" },
  { path: join(".agents", "skills"), mode: "agents" },
];

type Ignore = ReturnType<typeof ignore>;

/**
 * Discover the Repository Context of a worktree. Rejects if the worktree root
 * does not exist; any file that is missing, unreadable or outside the root is
 * simply absent from the result.
 */
export async function discoverRepositoryContext(worktreeRoot: string): Promise<RepositoryContext> {
  const root = resolve(worktreeRoot);
  const scope = new RootScope(root, await realpath(root));

  return {
    worktreeRoot: root,
    contextFile: await findContextFile(scope),
    appendSystem: await readContextFile(scope, join(root, ".pi", "APPEND_SYSTEM.md")),
    skills: await indexSkills(scope),
  };
}

/** Resolves paths and enforces the worktree-root boundary. */
class RootScope {
  constructor(
    readonly root: string,
    private readonly realRoot: string,
  ) {}

  /** Follows symlinks; returns null when the target is missing or outside the root. */
  async inspect(path: string): Promise<{ readonly kind: "file" | "dir" | "other"; readonly real: string } | null> {
    try {
      const real = await realpath(path);

      if (!isWithin(this.realRoot, real)) {return null;}

      const stats = await stat(real);

      return { kind: stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other", real };
    } catch {
      return null;
    }
  }

  relativePath(path: string): string {
    return toPosix(relative(this.root, path));
  }
}

async function findContextFile(scope: RootScope): Promise<RepositoryContextFile | null> {
  for (const name of CONTEXT_FILE_CANDIDATES) {
    const found = await readContextFile(scope, join(scope.root, name));

    if (found) {return found;}
  }

  return null;
}

async function readContextFile(scope: RootScope, path: string): Promise<RepositoryContextFile | null> {
  const target = await scope.inspect(path);

  if (target?.kind !== "file") {return null;}

  const content = await readText(target.real);

  return content === null ? null : { path: scope.relativePath(path), content };
}

async function indexSkills(scope: RootScope): Promise<Array<SkillHeader>> {
  const byName = new Map<string, { readonly header: SkillHeader; readonly hidden: boolean }>();
  const seenFiles = new Set<string>();

  for (const { path, mode } of SKILL_DIRS) {
    const dir = join(scope.root, path);
    const target = await scope.inspect(dir);

    if (target?.kind !== "dir") {continue;}

    const files = await collectSkillFiles(scope, dir, mode, ignore(), dir, new Set([target.real]));

    for (const file of files) {
      const real = (await scope.inspect(file))?.real;

      if (real === undefined || seenFiles.has(real)) {continue;}

      const parsed = await readSkillHeader(scope, file, real);

      if (!parsed) {continue;}

      seenFiles.add(real);

      // Pi keeps the first skill discovered under a name: `.pi/skills` before
      // `.agents/skills`. A hidden skill still claims its name.
      if (!byName.has(parsed.header.name)) {byName.set(parsed.header.name, parsed);}
    }
  }

  return [...byName.values()]
    .flatMap((skill) => (skill.hidden ? [] : [skill.header]))
    .sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path));
}

/**
 * Pi 1.6.0's skill-file collection, made deterministic by visiting entries in
 * code-unit order: a directory holding `SKILL.md` is one skill and is not
 * descended into; dot-entries, `node_modules` and ignore-file matches are skipped.
 */
async function collectSkillFiles(
  scope: RootScope,
  dir: string,
  mode: SkillDirMode,
  ig: Ignore,
  skillsRoot: string,
  visitedDirs: Set<string>,
): Promise<Array<string>> {
  let entries: Array<Dirent>;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => compare(a.name, b.name));
  await addIgnoreRules(scope, ig, dir, skillsRoot);
  const relativeToSkills = (path: string): string => toPosix(relative(skillsRoot, path));

  if (entries.some((entry) => entry.name === "SKILL.md")) {
    const skillFile = join(dir, "SKILL.md");
    const target = await scope.inspect(skillFile);

    if (target?.kind === "file" && !ig.ignores(relativeToSkills(skillFile))) {return [skillFile];}
  }

  const files: Array<string> = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {continue;}

    const path = join(dir, entry.name);
    const target = await scope.inspect(path);

    if (!target) {continue;}

    const rel = relativeToSkills(path);

    if (target.kind === "file") {
      const atSkillsRoot = dir === skillsRoot;
      const takesMarkdown = mode === "pi" ? atSkillsRoot : !atSkillsRoot;

      if (takesMarkdown && entry.name.endsWith(".md") && !ig.ignores(rel)) {files.push(path);}

      continue;
    }

    if (target.kind !== "dir" || ig.ignores(`${rel}/`) || visitedDirs.has(target.real)) {continue;}

    visitedDirs.add(target.real);
    files.push(...(await collectSkillFiles(scope, path, mode, ig, skillsRoot, visitedDirs)));
  }

  return files;
}

/** Pi's ignore-file handling: patterns are rebased onto the skills directory. */
async function addIgnoreRules(scope: RootScope, ig: Ignore, dir: string, skillsRoot: string): Promise<void> {
  const relativeDir = relative(skillsRoot, dir);
  const prefix = relativeDir ? `${toPosix(relativeDir)}/` : "";

  for (const name of IGNORE_FILE_NAMES) {
    // Through the scope, so an ignore file symlinked outside the root is absent.
    const target = await scope.inspect(join(dir, name));

    if (target?.kind !== "file") {continue;}

    let content: string;

    try {
      content = await readFile(target.real, "utf8");
    } catch {
      continue;
    }

    const patterns = content
      .split(/\r?\n/)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => line !== null);

    if (patterns.length > 0) {ig.add(patterns);}
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();

  if (!trimmed) {return null;}

  if (trimmed.startsWith("#") && !trimmed.startsWith(String.raw`\#`)) {return null;}

  let pattern = line;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith(String.raw`\!`)) {
    pattern = pattern.slice(1);
  }

  if (pattern.startsWith("/")) {pattern = pattern.slice(1);}

  const prefixed = `${prefix}${pattern}`;

  return negated ? `!${prefixed}` : prefixed;
}

/**
 * Reads only what the index needs from a skill file's frontmatter. As in Pi, a
 * skill without a non-empty description or with malformed frontmatter is not
 * loaded. A skill marked `disable-model-invocation: true` is loaded as hidden:
 * it claims its name but is absent from the index, as from Pi's prompt.
 */
async function readSkillHeader(
  scope: RootScope,
  file: string,
  real: string,
): Promise<{ readonly header: SkillHeader; readonly hidden: boolean } | null> {
  const raw = await readText(real);

  if (raw === null) {return null;}

  let frontmatter: Frontmatter;

  try {
    frontmatter = parseFrontmatter(raw);
  } catch {
    return null;
  }

  const description = frontmatter.description;

  if (!isText(description) || description.trim() === "") {return null;}

  const hidden = frontmatter["disable-model-invocation"] === true;
  const declaredName = frontmatter.name;
  const name = isText(declaredName) && declaredName !== "" ? declaredName : basename(dirname(file));

  return { header: { name, description, path: scope.relativePath(file) }, hidden };
}

/** The frontmatter keys a skill header reads; any other keys are ignored. */
const Frontmatter = Schema.Struct({
  name: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.Unknown),
  "disable-model-invocation": Schema.optionalKey(Schema.Unknown),
});

type Frontmatter = typeof Frontmatter.Type;

const isFrontmatter = Schema.is(Frontmatter);

const isText = Schema.is(Schema.String);

/** A YAML mapping, as opposed to a scalar or a list. */
const isMapping = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Pi's frontmatter extraction: a leading `---` block, closed by the next line starting `---`. */
function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replaceAll('\r\n', "\n").replaceAll('\r', "\n");

  if (!normalized.startsWith("---")) {return {};}

  const end = normalized.indexOf("\n---", 3);

  if (end === -1) {return {};}

  const parsed: unknown = parseYaml(normalized.slice(4, end));

  return isMapping(parsed) && isFrontmatter(parsed) ? parsed : {};
}

async function readText(path: string): Promise<string | null> {
  try {
    return stripBom(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);

  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
