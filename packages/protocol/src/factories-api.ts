/**
 * The factory list and factory stop over the management API (PRD §10.3, §11.1–§11.2, §13.1):
 * `foundry factory list` and `foundry factory stop <name> [--force]`. The daemon answers from its
 * state: the configuration loads recorded for the run it is serving, and the factories it has
 * stopped in that run.
 */
import { Schema } from "effect";

import { MANAGEMENT_API_PREFIX } from "./management-api.js";

/** `GET`: the factories loaded by the answering daemon's run (`foundry factory list`). */
export const FACTORIES_PATH = `${MANAGEMENT_API_PREFIX}/factories`;

const FACTORIES_PREFIX = `${FACTORIES_PATH}/`;
const STOP_SUFFIX = "/stop";

/**
 * A factory's state in this run. `stopping` while a stop is under way, and after a stop that could
 * not confirm every owned process group gone; `stopped` once it did. A stopped factory comes back
 * only on the next daemon start (PRD §10.3). Refusing a factory's start arrives with its own ticket.
 */
export const FactoryState = Schema.Literals(["running", "stopping", "stopped"]);

export type FactoryState = typeof FactoryState.Type;

/** One loaded factory and the configuration load the daemon recorded for it. */
export const FactorySummary = Schema.Struct({
  /** The factory's name: its stable identifier. */
  factoryId: Schema.String,
  state: FactoryState,
  /** The recorded configuration load: what transitions in this run carry. */
  loadId: Schema.Number,
  /** Absolute path of the YAML file the configuration was read from. */
  yamlFile: Schema.String,
  /** `sha256:<hex>` of the validated configuration. */
  configHash: Schema.String,
  knowledgeRoot: Schema.String,
});

export type FactorySummary = typeof FactorySummary.Type;

/** Result of `GET /api/v1/factories`, ordered by load. */
export const FactoryListResult = Schema.Struct({
  /** The run the answering daemon serves. */
  runId: Schema.String,
  /** ISO 8601 time the run started, when its configuration was loaded. */
  loadedAt: Schema.String,
  factories: Schema.Array(FactorySummary),
});

export type FactoryListResult = typeof FactoryListResult.Type;

export const isFactorySummary = Schema.is(FactorySummary);

export const isFactoryListResult = Schema.is(FactoryListResult);

/** `POST`: stop one factory's workers, leaving the others alone (`foundry factory stop`). */
export const factoryStopPath = (factory: string): string => `${FACTORIES_PREFIX}${encodeURIComponent(factory)}${STOP_SUFFIX}`;

/**
 * The factory name a request path asks to stop: `undefined` when the path is not this route,
 * `null` when it is but the name segment is not valid percent-encoding.
 */
export const matchFactoryStopPath = (path: string): string | null | undefined => {
  if (!path.startsWith(FACTORIES_PREFIX) || !path.endsWith(STOP_SUFFIX)) {return undefined;}

  const segment = path.slice(FACTORIES_PREFIX.length, path.length - STOP_SUFFIX.length);

  if (segment === "" || segment.includes("/")) {return undefined;}

  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** Body of a stop request. `force` skips the drain and the grace period. An empty body is `{}`. */
export const FactoryStopRequest = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
});

export type FactoryStopRequest = typeof FactoryStopRequest.Type;

/** What the stop did with one of the factory's launches; every one is confirmed gone on success. */
export const StoppedLaunch = Schema.Struct({
  launchId: Schema.String,
  slotId: Schema.String,
  /** Whether the worker acknowledged the drain within the grace period. Always false with `force`. */
  drained: Schema.Boolean,
  /** Whether the host had to SIGKILL the group. */
  escalated: Schema.Boolean,
});

export type StoppedLaunch = typeof StoppedLaunch.Type;

/** Result of a successful stop: every owned process group of the factory is confirmed gone. */
export const FactoryStopResult = Schema.Struct({
  factoryId: Schema.String,
  state: Schema.Literal("stopped"),
  force: Schema.Boolean,
  launches: Schema.Array(StoppedLaunch),
});

export type FactoryStopResult = typeof FactoryStopResult.Type;

export const isFactoryStopResult = Schema.is(FactoryStopResult);
