import { accessSync, constants, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeFactoryYaml, DecodeResult, locateProblems } from "./decode.js";
import type { ConfigProblem } from "./decode.js";
import { resolveConfiguredPath as resolveFrom } from "./paths.js";
import type { FactoryConfig } from "./schema.js";

/**
 * Offline checks on a decoded factory configuration (PRD §4): configured files,
 * the repository source, branch and path settings, and command arrays.
 *
 * Read-only: it only stats and opens-for-access. It creates no directory,
 * contacts no remote and runs no command. Command arguments are left unchanged
 * and are not resolved as paths.
 */

export interface OfflineCheckOptions {
  /** The factory YAML file; relative paths resolve from its directory. */
  readonly yamlFile: string;
  /** The home directory a leading `~` expands to. Defaults to the process's. */
  readonly home?: string;
}

type Path = ReadonlyArray<string | number>;

/** A problem with its setting path as segments, joined into a dotted path when reported. */
interface SettingProblem {
  readonly path: Path;
  readonly message: string;
}

/** Resolves a configured path against the YAML's directory, via the shared helper. */
const resolveConfiguredPath = (value: string, options: OfflineCheckOptions): string =>
  resolveFrom(value, dirname(resolve(options.yamlFile)), options.home);

const statOf = (path: string): Stats | undefined => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

const readable = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);

    return true;
  } catch {
    return false;
  }
};

/** A configured file must exist, be a regular file and be readable. */
const checkFile = (path: Path, value: string, options: OfflineCheckOptions): Array<SettingProblem> => {
  const absolute = resolveConfiguredPath(value, options);
  const stats = statOf(absolute);

  if (stats === undefined) {return [{ path, message: `Configured file not found: ${absolute}` }];}

  if (!stats.isFile()) {return [{ path, message: `Configured path is not a file: ${absolute}` }];}

  if (!readable(absolute)) {return [{ path, message: `Configured file is not readable: ${absolute}` }];}

  return [];
};

/** A directory Foundry may create later must, if it already exists, be a directory. */
const checkDirectorySetting = (
  path: Path,
  value: string,
  options: OfflineCheckOptions,
): Array<SettingProblem> => {
  const absolute = resolveConfiguredPath(value, options);
  const stats = statOf(absolute);

  if (stats !== undefined && !stats.isDirectory()) {
    return [{ path, message: `Path exists but is not a directory: ${absolute}` }];
  }

  return [];
};

const URL_SCHEMES = new Set(["http:", "https:", "ssh:", "git:", "file:"]);
const SCP_LIKE = /^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** True when a repository source is a URL (scheme or scp-like) rather than a local path. */
export const isUrlSource = (source: string): boolean =>
  HAS_SCHEME.test(source) || (SCP_LIKE.test(source) && !source.startsWith("/") && !source.startsWith("."));

/** A URL source is checked for form only; a local source must be a directory. */
const checkSource = (source: string, options: OfflineCheckOptions): Array<SettingProblem> => {
  const path = ["repository", "source"];

  if (HAS_SCHEME.test(source)) {
    let url: URL;

    try {
      url = new URL(source);
    } catch {
      return [{ path, message: `Malformed repository URL: ${source}` }];
    }

    if (!URL_SCHEMES.has(url.protocol)) {
      return [{ path, message: `Unsupported repository URL scheme "${url.protocol}"` }];
    }

    if (url.protocol !== "file:" && url.hostname === "") {
      return [{ path, message: `Repository URL has no host: ${source}` }];
    }

    if (url.pathname === "" || url.pathname === "/") {
      return [{ path, message: `Repository URL has no repository path: ${source}` }];
    }

    return [];
  }

  if (isUrlSource(source)) {return [];}

  const absolute = resolveConfiguredPath(source, options);
  const stats = statOf(absolute);

  if (stats === undefined) {return [{ path, message: `Repository source not found: ${absolute}` }];}

  if (!stats.isDirectory()) {
    return [{ path, message: `Repository source is not a directory: ${absolute}` }];
  }

  return [];
};

/**
 * Why `name` is not a valid Git branch name (the `git check-ref-format --branch`
 * rules), or undefined when it is valid. Checked without running Git.
 */
export const branchNameProblem = (name: string): string | undefined => {
  if (name === "@") {return "is \"@\"";}

  if (name === "HEAD") {return "is \"HEAD\"";}

  if (name.startsWith("-")) {return "starts with \"-\"";}

  if (name.startsWith("/") || name.endsWith("/")) {return "starts or ends with \"/\"";}

  if (name.includes("//")) {return "contains \"//\"";}

  if (name.endsWith(".")) {return "ends with \".\"";}

  if (name.includes("..")) {return "contains \"..\"";}

  if (name.includes("@{")) {return "contains \"@{\"";}

  // Control characters, space, DEL and the characters Git forbids.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) {return "contains a forbidden character";}

  for (const component of name.split("/")) {
    if (component.startsWith(".")) {return "has a component starting with \".\"";}

    if (component.endsWith(".lock")) {return "has a component ending with \".lock\"";}
  }

  return undefined;
};

const BRANCH_PLACEHOLDERS = new Set(["ticket-id", "slug"]);

// Requiring {ticket-id} follows from PRD §9.2: one branch per ticket for its
// whole life. A pattern with only {slug} (or no placeholder) lets two tickets
// collide on one branch.

/** The branch pattern may use only known placeholders, must name the ticket and must form a valid branch. */
const checkBranchPattern = (pattern: string): Array<SettingProblem> => {
  const path = ["worktrees", "branch_pattern"];
  const placeholders = [...pattern.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? "");
  const unknown = placeholders.filter((name) => !BRANCH_PLACEHOLDERS.has(name));

  if (unknown.length > 0) {
    return [{ path, message: `Unknown placeholder ${unknown.map((n) => `{${n}}`).join(", ")}; use {ticket-id} and {slug}` }];
  }

  if (!placeholders.includes("ticket-id")) {
    return [{ path, message: "Branch pattern must contain {ticket-id} so each ticket gets its own branch" }];
  }

  const sample = pattern.replaceAll("{ticket-id}", "t1").replaceAll("{slug}", "s");
  const reason = branchNameProblem(sample);

  return reason === undefined ? [] : [{ path, message: `Branch pattern does not form a valid branch name: ${reason}` }];
};

/** A command is a non-empty argument list whose program is not empty. Arguments are not otherwise inspected. */
const checkCommand = (path: Path, command: ReadonlyArray<string> | undefined): Array<SettingProblem> => {
  if (command === undefined) {return [];}

  if (command.length === 0) {return [{ path, message: "Command must not be empty" }];}

  if (command[0] === "") {return [{ path: [...path, 0], message: "Command program must not be empty" }];}

  return [];
};

type Extension = string | { readonly path: string };

const extensionPath = (entry: Extension): string => (typeof entry === "string" ? entry : entry.path);

const checkResources = (
  base: Path,
  settings: {
    readonly instructions?: string;
    readonly skills?: ReadonlyArray<string>;
    readonly extensions?: ReadonlyArray<Extension>;
  },
  options: OfflineCheckOptions,
): Array<SettingProblem> => [
  ...(settings.instructions === undefined
    ? []
    : checkFile([...base, "instructions"], settings.instructions, options)),
  ...(settings.skills ?? []).flatMap((skill, index) =>
    checkFile([...base, "skills", index], skill, options),
  ),
  ...(settings.extensions ?? []).flatMap((entry, index) =>
    checkFile(
      typeof entry === "string" ? [...base, "extensions", index] : [...base, "extensions", index, "path"],
      extensionPath(entry),
      options,
    ),
  ),
];

/** Runs every offline check on a decoded configuration and returns its problems. */
export const checkOffline = (
  config: FactoryConfig,
  options: OfflineCheckOptions,
): ReadonlyArray<ConfigProblem> => {
  const problems: Array<SettingProblem> = [];
  problems.push(...checkSource(config.repository.source, options));
  const branch = branchNameProblem(config.repository.default_branch);

  if (branch !== undefined) {
    problems.push({ path: ["repository", "default_branch"], message: `Invalid branch name: ${branch}` });
  }

  // Decoding fills these defaults in; the schema's type still marks them optional.
  const worktrees = config.worktrees ?? {};

  if (worktrees.root !== undefined) {
    problems.push(...checkDirectorySetting(["worktrees", "root"], worktrees.root, options));
  }

  if (worktrees.branch_pattern !== undefined) {
    problems.push(...checkBranchPattern(worktrees.branch_pattern));
  }

  problems.push(...checkCommand(["worktrees", "after_create"], worktrees.after_create), ...checkCommand(["worktrees", "before_remove"], worktrees.before_remove));
  const knowledgeRoot = config.knowledge?.root;

  if (knowledgeRoot !== undefined) {
    problems.push(...checkDirectorySetting(["knowledge", "root"], knowledgeRoot, options));
  }

  if (config.defaults !== undefined) {
    problems.push(...checkResources(["defaults"], config.defaults, options));
  }

  for (const [roomName, room] of Object.entries(config.rooms)) {
    problems.push(...checkResources(["rooms", roomName], room, options));

    for (const [stationName, station] of Object.entries(room.stations)) {
      problems.push(...checkResources(["rooms", roomName, "stations", stationName], station, options));
    }
  }

  for (const [lineName, line] of Object.entries(config.production_lines)) {
    problems.push(...checkCommand(["production_lines", lineName, "verify"], line.verify));
  }

  return problems.map((problem) => ({ path: problem.path.map(String).join("."), message: problem.message }));
};

const isInvalid = DecodeResult.$is("Invalid");

/**
 * Decodes factory YAML and runs the offline checks against the files beside it.
 * This is the shared read-only validation for `foundry validate` and daemon start.
 */
export const validateFactoryYaml = (text: string, options: OfflineCheckOptions): DecodeResult => {
  const decoded = decodeFactoryYaml(text);

  if (isInvalid(decoded)) {return decoded;}

  const problems = [...locateProblems(text, checkOffline(decoded.config, options))];
  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));

  return problems.length === 0 ? decoded : DecodeResult.Invalid({ problems });
};
