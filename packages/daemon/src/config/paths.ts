import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolves a configured filesystem path (PRD §4 "Placeholders and paths"): a
 * leading `~` expands to the home directory, and a relative path resolves from
 * the factory YAML's directory. Command arguments are never passed here.
 *
 * Decision (FOU-25): `~` expands for every configured file path and root
 * (instructions, skills, extensions, repository source, worktree and knowledge
 * roots), because the PRD's own default `worktrees.root: ~/worktrees` needs it.
 * The offline checks and station resolution both use this one helper, so a path
 * that passes validation names the same file at priming. `~user` is not
 * expanded. This is not placeholder expansion: `${NAME}` stays model-only.
 */
export const resolveConfiguredPath = (
  value: string,
  baseDir: string,
  home: string = homedir(),
): string => {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(baseDir, value);
};
