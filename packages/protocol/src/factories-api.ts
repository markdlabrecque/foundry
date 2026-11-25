/**
 * The factory list over the management API (PRD §11.1–§11.2, §13.1): `foundry factory list`.
 * The daemon answers from its state: the configuration loads recorded for the run it is serving.
 */
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

/** `GET`: the factories loaded by the answering daemon's run (`foundry factory list`). */
export const FACTORIES_PATH = `${MANAGEMENT_API_PREFIX}/factories`;

/**
 * A factory's state. P0 serves `running` for every factory loaded in this run; stopping a factory
 * and refusing its start (`stopped`, `refused`) arrive with their own tickets.
 */
export type FactoryState = "running";

/** One loaded factory and the configuration load the daemon recorded for it. */
export interface FactorySummary {
  /** The factory's name: its stable identifier. */
  readonly factoryId: string;
  readonly state: FactoryState;
  /** The recorded configuration load: what transitions in this run carry. */
  readonly loadId: number;
  /** Absolute path of the YAML file the configuration was read from. */
  readonly yamlFile: string;
  /** `sha256:<hex>` of the validated configuration. */
  readonly configHash: string;
  readonly knowledgeRoot: string;
}

/** Result of `GET /api/v1/factories`, ordered by load. */
export interface FactoryListResult {
  /** The run the answering daemon serves. */
  readonly runId: string;
  /** ISO 8601 time the run started, when its configuration was loaded. */
  readonly loadedAt: string;
  readonly factories: ReadonlyArray<FactorySummary>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isFactorySummary = (value: unknown): value is FactorySummary =>
  isRecord(value) &&
  typeof value["factoryId"] === "string" &&
  value["state"] === "running" &&
  typeof value["loadId"] === "number" &&
  typeof value["yamlFile"] === "string" &&
  typeof value["configHash"] === "string" &&
  typeof value["knowledgeRoot"] === "string";

export const isFactoryListResult = (value: unknown): value is FactoryListResult =>
  isRecord(value) &&
  typeof value["runId"] === "string" &&
  typeof value["loadedAt"] === "string" &&
  Array.isArray(value["factories"]) &&
  value["factories"].every(isFactorySummary);
