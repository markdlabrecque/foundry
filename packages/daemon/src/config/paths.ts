import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Resolves a configured filesystem path (PRD §4 "Placeholders and paths"): a
 * leading `~` expands to the home directory, and a relative path resolves from
 * the factory YAML's directory. Command arguments are never passed here.
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
