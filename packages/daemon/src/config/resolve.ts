import type { ConfigProblem } from "./decode.js";
import { resolveConfiguredPath } from "./paths.js";
import type { FactoryConfig } from "./schema.js";

/**
 * Effective station settings (PRD §4 "Inheritance" and "Placeholders and paths").
 *
 * - Instructions compose factory → room → station; each level adds at most one file.
 * - A station's model overrides `defaults.model`. A whole-field `${NAME}` model
 *   resolves from the given environment; this is the only place Foundry expands
 *   placeholders. Every station must end up with a `provider/model` selector.
 * - Skills and extensions: omission inherits the factory default, a station list
 *   replaces it, and `[]` clears it. Extension tool names travel with their extension.
 *
 * Pure: it reads no files and checks no names, references or files (other checks
 * do that). Relative paths resolve from `baseDir`, the YAML's directory, and a
 * leading `~` expands to the home directory, as in the offline checks.
 */

/** A configured extension with the tools it contributes; `[]` means hooks only. */
export interface EffectiveExtension {
  readonly path: string;
  readonly tools: ReadonlyArray<string>;
}

export interface EffectiveStation {
  /** `room.station`. */
  readonly address: string;
  readonly room: string;
  readonly station: string;
  /** Absolute instruction file paths in factory → room → station order. */
  readonly instructions: ReadonlyArray<string>;
  /** The resolved `provider/model` selector. */
  readonly model: string;
  readonly skills: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<EffectiveExtension>;
  readonly instances: number;
  readonly isolation: "none" | "worktree";
}

export interface ResolveOptions {
  /** The invoking process environment, read for model placeholders only. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The factory YAML's directory; relative paths resolve from here. */
  readonly baseDir: string;
  /** The home directory a leading `~` expands to. Defaults to the process's. */
  readonly home?: string;
}

export type ResolveResult =
  | { readonly _tag: "Resolved"; readonly stations: ReadonlyArray<EffectiveStation> }
  | { readonly _tag: "Invalid"; readonly problems: ReadonlyArray<ConfigProblem> };

/** A whole-field placeholder. Anything else in a model field is taken literally. */
const PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** An explicit `provider/model` selector: a provider, a slash, then a model. */
const SELECTOR = /^[^/\s]+\/\S+$/;

type ModelOutcome = { readonly model: string } | { readonly problem: ConfigProblem };

const resolveModel = (
  raw: string,
  path: string,
  env: ResolveOptions["env"],
): ModelOutcome => {
  const placeholder = PLACEHOLDER.exec(raw);
  let model = raw;

  if (placeholder !== null) {
    const name = placeholder[1] as string;
    const value = env[name];

    if (value === undefined) {
      return { problem: { path, message: `Model variable ${name} is not set` } };
    }

    if (value === "") {return { problem: { path, message: `Model variable ${name} is empty` } };}

    model = value;
  }

  if (!SELECTOR.test(model)) {
    const shown = placeholder === null ? `"${model}"` : `"${model}" (from ${raw})`;

    return {
      problem: { path, message: `Model ${shown} is not an explicit provider/model selector` },
    };
  }

  return { model };
};

export const resolveStations = (config: FactoryConfig, options: ResolveOptions): ResolveResult => {
  const toPath = (path: string): string =>
    resolveConfiguredPath(path, options.baseDir, options.home);

  const toExtension = (entry: string | { readonly path: string; readonly tools: ReadonlyArray<string> }): EffectiveExtension =>
    typeof entry === "string"
      ? { path: toPath(entry), tools: [] }
      : { path: toPath(entry.path), tools: [...entry.tools] };

  const defaults = config.defaults ?? {};
  const problems: Array<ConfigProblem> = [];

  // The factory model resolves once, and an unresolvable one is an error even
  // when every station overrides it: an unset or empty variable is an error.
  const defaultModel =
    defaults.model === undefined ? undefined : resolveModel(defaults.model, "defaults.model", options.env);

  if (defaultModel !== undefined && "problem" in defaultModel) {problems.push(defaultModel.problem);}

  const stations: Array<EffectiveStation> = [];

  for (const [roomName, room] of Object.entries(config.rooms)) {
    for (const [stationName, station] of Object.entries(room.stations)) {
      const stationPath = `rooms.${roomName}.stations.${stationName}`;

      let model: string | undefined;

      if (station.model !== undefined) {
        const outcome = resolveModel(station.model, `${stationPath}.model`, options.env);

        if ("problem" in outcome) {problems.push(outcome.problem);}
        else {model = outcome.model;}
      } else if (defaultModel === undefined) {
        problems.push({
          path: stationPath,
          message: "No model: set defaults.model or the station's model",
        });
      } else if ("model" in defaultModel) {
        model = defaultModel.model;
      }

      if (model === undefined) {continue;}

      const instructions = [defaults.instructions, room.instructions, station.instructions]
        .filter((path): path is string => path !== undefined)
        .map(toPath);

      stations.push({
        address: `${roomName}.${stationName}`,
        room: roomName,
        station: stationName,
        instructions,
        model,
        skills: (station.skills ?? defaults.skills ?? []).map(toPath),
        extensions: (station.extensions ?? defaults.extensions ?? []).map(toExtension),
        // The decoder applies these defaults; its type still marks them optional.
        instances: station.instances ?? 1,
        isolation: station.isolation ?? "none",
      });
    }
  }

  return problems.length > 0 ? { _tag: "Invalid", problems } : { _tag: "Resolved", stations };
};
