/**
 * Factory configuration loads on daemon start (PRD §4 "Loading", §5.4.3, §10.1).
 *
 * Each factory YAML named on the daemon's command line goes through the same offline checks as
 * `foundry validate` (`validateFactoryYaml`, then `resolveStations`); nothing is checked twice
 * here. Once every file is valid, the daemon creates each factory's reserved, empty knowledge
 * layout and records the run and every configuration load (the validated configuration and its
 * hash) in one store change, with a history row for each.
 *
 * Loading reads files only; creating the knowledge layout and recording happen after the
 * state root is claimed. Nothing here clones, contacts a remote, runs a command or launches a worker.
 */
import { createHash } from "node:crypto";
import { messageOf } from "@foundry/protocol/errors";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { DecodeResult, locateProblems, resolveConfiguredPath, ResolveResult, resolveStations, validateFactoryYaml } from "./config/index.js";
import type { ConfigProblem, EffectiveStation, FactoryConfig } from "./config/index.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Store, StoreError } from "./store.js";

/**
 * The factory ID on history rows that belong to the instance rather than one factory, such as
 * `run.started`. Factory IDs are factory names, which are never empty.
 */
export const INSTANCE_FACTORY_ID = "";

/** A factory configuration that passed every offline check, ready to record. */
export interface LoadedFactory {
  /** The factory's name: its stable identifier. */
  readonly factoryId: string;
  /** Absolute path of the YAML file it was read from. */
  readonly yamlFile: string;
  readonly config: FactoryConfig;
  readonly stations: ReadonlyArray<EffectiveStation>;
  /** Findings that do not refuse the load, such as a line with no `verify`. */
  readonly warnings: ReadonlyArray<ConfigProblem>;
  /** The stored, validated configuration: the decoded config and its effective stations, as JSON. */
  readonly configJson: string;
  /**
   * `sha256:<hex>` of `configJson`, not of the YAML text: comments and formatting do not change it,
   * while a changed `${NAME}` model value does. The effective stations hold resolved absolute
   * paths, so moving the checkout (or the YAML) also changes it.
   */
  readonly configHash: string;
  /** Absolute knowledge root and the empty directories reserved beneath it (§5.4.3). */
  readonly knowledge: { readonly root: string; readonly directories: ReadonlyArray<string> };
}

export type LoadFactoriesResult = Data.TaggedEnum<{
  Loaded: { readonly factories: ReadonlyArray<LoadedFactory> };
  /** `message` is one line naming the first problem. */
  Refused: { readonly message: string };
}>;

export const LoadFactoriesResult = Data.taggedEnum<LoadFactoriesResult>();

const isInvalidConfig = DecodeResult.$is("Invalid");

const isUnresolved = ResolveResult.$is("Invalid");

export interface LoadFactoriesOptions {
  /** The daemon's environment, read for model placeholders only. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The home directory a leading `~` expands to. Defaults to the process's. */
  readonly home?: string;
}

const describe = (file: string, problem: ConfigProblem): string => {
  const location = problem.line === undefined ? file : `${file}:${problem.line}:${problem.column ?? 1}`;
  const setting = problem.path === "" ? "" : ` ${problem.path}:`;

  return `${location}:${setting} ${problem.message}`;
};

const refuseProblems = (file: string, problems: ReadonlyArray<ConfigProblem>): LoadFactoriesResult => {
  const more = problems.length > 1 ? ` (${problems.length - 1} more; run foundry validate ${file})` : "";

  return LoadFactoriesResult.Refused({ message: `${describe(file, problems[0]!)}${more}` });
};

/** The flat layout of §5.4.3: the root, `<root>/<room>/` and `<root>/<station>/`. */
const knowledgeLayout = (config: FactoryConfig, baseDir: string, home: string | undefined) => {
  // The decoder fills in the default `knowledge`; its type still marks it optional.
  const root = resolveConfiguredPath(config.knowledge?.root ?? "knowledge", baseDir, home);
  const names = Object.entries(config.rooms).flatMap(([room, { stations }]) => [room, ...Object.keys(stations)]);

  return { root, directories: [root, ...names.map((name) => join(root, name))] };
};

/**
 * Reads and validates every factory file, read-only. Refuses on the first file with a problem,
 * and when two files name the same factory.
 */
export const loadFactoryFiles = (
  files: ReadonlyArray<string>,
  options: LoadFactoriesOptions,
): LoadFactoriesResult => {
  const factories: Array<LoadedFactory> = [];

  for (const file of files) {
    let text: string;

    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      return LoadFactoriesResult.Refused({ message: `${file}: cannot read factory YAML: ${messageOf(error)}` });
    }

    const yamlFile = resolve(file);
    const baseDir = dirname(yamlFile);
    const validated = validateFactoryYaml(text, { yamlFile, ...(options.home === undefined ? {} : { home: options.home }) });

    if (isInvalidConfig(validated)) {return refuseProblems(file, validated.problems);}

    const resolved = resolveStations(validated.config, {
      env: options.env,
      baseDir,
      ...(options.home === undefined ? {} : { home: options.home }),
    });

    if (isUnresolved(resolved)) {return refuseProblems(file, locateProblems(text, resolved.problems));}

    const factoryId = validated.config.name;
    const clash = factories.find((f) => f.factoryId === factoryId);

    if (clash !== undefined) {
      return LoadFactoriesResult.Refused({ message: `${file}: factory "${factoryId}" is already loaded from ${clash.yamlFile}` });
    }

    const configJson = JSON.stringify({ config: validated.config, stations: resolved.stations });
    factories.push({
      factoryId,
      yamlFile,
      config: validated.config,
      stations: resolved.stations,
      warnings: locateProblems(text, validated.warnings),
      configJson,
      configHash: `sha256:${createHash("sha256").update(configJson).digest("hex")}`,
      knowledge: knowledgeLayout(validated.config, baseDir, options.home),
    });
  }

  return LoadFactoriesResult.Loaded({ factories });
};

/** Creates the reserved knowledge directories, leaving any that exist (and their contents) alone. */
export const createKnowledgeLayout = (factory: LoadedFactory): void => {
  for (const directory of factory.knowledge.directories) {mkdirSync(directory, { recursive: true });}
};

/** One recorded configuration load. */
export interface RecordedLoad {
  readonly loadId: number;
  readonly factoryId: string;
  readonly configHash: string;
}

export interface RunRecord {
  readonly runId: string;
  /** Wall-clock milliseconds since the Unix epoch. */
  readonly startedAt: number;
  /** The Foundry version that started. */
  readonly version: string;
  readonly factories: ReadonlyArray<LoadedFactory>;
}

/** Records the run and each configuration load in one change, with a history row for each. */
export const recordRun = (store: Store, run: RunRecord): Effect.Effect<ReadonlyArray<RecordedLoad>, StoreError> =>
  store.change(({ query, recordHistory }) =>
    Effect.gen(function* () {
      yield* query(`INSERT INTO run (id, started_at, version) VALUES (?, ?, ?)`, [run.runId, run.startedAt, run.version]);
      yield* recordHistory({
        factoryId: INSTANCE_FACTORY_ID,
        kind: "run.started",
        subject: run.runId,
        detail: { version: run.version, factories: run.factories.map((f) => f.factoryId) },
      });
      const loads: Array<RecordedLoad> = [];

      for (const factory of run.factories) {
        const rows = yield* query<{ id: number }>(
          `INSERT INTO factory_config_load (run_id, factory_id, yaml_file, config, config_hash, knowledge_root)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          [run.runId, factory.factoryId, factory.yamlFile, factory.configJson, factory.configHash, factory.knowledge.root],
        );

        const loadId = rows[0]!.id;
        yield* recordHistory({
          factoryId: factory.factoryId,
          kind: "factory.config_loaded",
          subject: String(loadId),
          detail: { runId: run.runId, configHash: factory.configHash, yamlFile: factory.yamlFile },
        });
        loads.push({ loadId, factoryId: factory.factoryId, configHash: factory.configHash });
      }

      return loads;
    }),
  );
