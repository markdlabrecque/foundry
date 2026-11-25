/**
 * The factory list over the management API (PRD §11.1–§11.2, §13.1): `foundry factory list`.
 * The daemon answers from its state: the configuration loads recorded for the run it is serving.
 */
import { Schema } from "effect";

import { MANAGEMENT_API_PREFIX } from "./management-api.js";

/** `GET`: the factories loaded by the answering daemon's run (`foundry factory list`). */
export const FACTORIES_PATH = `${MANAGEMENT_API_PREFIX}/factories`;

/**
 * A factory's state. P0 serves `running` for every factory loaded in this run; stopping a factory
 * and refusing its start (`stopped`, `refused`) arrive with their own tickets.
 */
export const FactoryState = Schema.Literal("running");

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
