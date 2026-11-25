/**
 * `foundry factory sync <name> [--wait]` over the management API (PRD §9.1, §11.1, §11.5): queues a
 * sync of the factory's clone from its source. The answer is the queued operation; with `wait` the
 * daemon answers once the sync has finished.
 */
import { Schema } from "effect";

import { MANAGEMENT_API_PREFIX } from "./management-api.js";

const FACTORIES_PREFIX = `${MANAGEMENT_API_PREFIX}/factories/`;
const SYNC_SUFFIX = "/sync";

/** Query parameter: `1` to answer only once the sync has finished. */
export const WAIT_PARAM = "wait";

/** `POST`: queue a sync of one loaded factory's clone. */
export const factorySyncPath = (factory: string, wait = false): string =>
  `${FACTORIES_PREFIX}${encodeURIComponent(factory)}${SYNC_SUFFIX}${wait ? `?${WAIT_PARAM}=1` : ""}`;

/**
 * The factory name a request path asks to sync: `undefined` when the path is not this route,
 * `null` when it is but the name segment is not valid percent-encoding.
 */
export const matchFactorySyncPath = (path: string): string | null | undefined => {
  if (!path.startsWith(FACTORIES_PREFIX) || !path.endsWith(SYNC_SUFFIX)) {return undefined;}

  const segment = path.slice(FACTORIES_PREFIX.length, path.length - SYNC_SUFFIX.length);

  if (segment === "" || segment.includes("/")) {return undefined;}

  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const Detail = Schema.Record(Schema.String, Schema.Json);

/** The sync operation as recorded (PRD §9.4). */
export const SyncOperation = Schema.Struct({
  id: Schema.Number,
  status: Schema.String,
  /** What the sync set out to do; `recordedHead` and `fetchedHead` once it has fetched. */
  intent: Detail,
  /** `null` until it finishes; then `previousHead`, `fetchedHead` and `head`. */
  result: Schema.NullOr(Detail),
});

export type SyncOperation = typeof SyncOperation.Type;

export const FactorySyncResult = Schema.Struct({
  factory: Schema.String,
  operation: SyncOperation,
});

export type FactorySyncResult = typeof FactorySyncResult.Type;

export const isFactorySyncResult = Schema.is(FactorySyncResult);
