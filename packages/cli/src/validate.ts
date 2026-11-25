import { readFileSync } from "node:fs";
import { decodeFactoryYaml } from "@foundry/daemon/config";
import type { ConfigProblem } from "@foundry/daemon/config";

/** What `foundry validate` prints and the exit code it ends with. */
export interface ValidateOutcome {
  readonly exitCode: 0 | 1;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}

const describe = (file: string, problem: ConfigProblem): string => {
  const location =
    problem.line === undefined ? file : `${file}:${problem.line}:${problem.column ?? 1}`;
  const setting = problem.path === "" ? "" : ` ${problem.path}:`;
  return `${location}:${setting} ${problem.message}`;
};

/**
 * Validates one factory YAML file, read-only and offline (PRD §4).
 * Reads the file and decodes it; it writes nothing and runs nothing.
 */
export const validateFactoryFile = (file: string): ValidateOutcome => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: [], stderr: [`${file}: cannot read factory YAML: ${reason}`] };
  }
  const result = decodeFactoryYaml(text);
  if (result._tag === "Valid") {
    return {
      exitCode: 0,
      stdout: [`${file}: factory "${result.config.name}" is valid`],
      stderr: result.warnings.map((w) => `${describe(file, w)} (warning)`),
    };
  }
  return { exitCode: 1, stdout: [], stderr: result.problems.map((p) => describe(file, p)) };
};
