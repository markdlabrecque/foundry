import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DecodeResult, locateProblems, ResolveResult, resolveStations, validateFactoryYaml } from "@foundry/daemon/config";
import type { ConfigProblem } from "@foundry/daemon/config";
import { renderToolSets } from "./tool-set-listing.js";

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
 * Reads the file, decodes it and checks the files and settings it names;
 * it creates nothing, contacts nothing and runs nothing.
 */
export const validateFactoryFile = (file: string): ValidateOutcome => {
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { exitCode: 1, stdout: [], stderr: [`${file}: cannot read factory YAML: ${reason}`] };
  }

  // Decode, then the offline file and setting checks, then station resolution.
  const result = validateFactoryYaml(text, { yamlFile: file });

  if (DecodeResult.$is("Invalid")(result)) {
    return { exitCode: 1, stdout: [], stderr: result.problems.map((p) => describe(file, p)) };
  }

  const stations = resolveStations(result.config, {
    env: process.env,
    baseDir: dirname(resolve(file)),
  });

  if (ResolveResult.$is("Invalid")(stations)) {
    const problems = locateProblems(text, stations.problems);

    return { exitCode: 1, stdout: [], stderr: problems.map((p) => describe(file, p)) };
  }

  return {
    exitCode: 0,
    stdout: [`${file}: factory "${result.config.name}" is valid`, ...renderToolSets(stations.stations)],
    stderr: result.warnings.map((w) => `${describe(file, w)} (warning)`),
  };
};
