/**
 * Whole-instance shutdown over the management API (PRD §10.3, §11.1, §13.1): `foundry shutdown
 * [--force]`. The daemon stops every factory with the scoped factory stop, then the Worker Host,
 * and answers only once every owned process group is confirmed gone and the host has accepted
 * the stop; the host exits right after it accepts.
 */
import { Schema } from "effect";

import { FactoryStopResult } from "./factories-api.js";
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

/** `POST`: stop every factory's workers, then the Worker Host, then the daemon. */
export const SHUTDOWN_PATH = `${MANAGEMENT_API_PREFIX}/shutdown`;

/** Body of a shutdown request. `force` skips the drain and the grace period. An empty body is `{}`. */
export const ShutdownRequest = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
});

export type ShutdownRequest = typeof ShutdownRequest.Type;

/** Result of a successful shutdown: no owned process group is left and the host accepted the stop. */
export const ShutdownResult = Schema.Struct({
  force: Schema.Boolean,
  /** One per factory this shutdown stopped; a factory already stopped in this run is not listed. */
  factories: Schema.Array(FactoryStopResult),
  /**
   * True once the Worker Host accepted the stop (it exits right after); false only when no host
   * answered, so there was none to stop.
   */
  hostStopped: Schema.Boolean,
});

export type ShutdownResult = typeof ShutdownResult.Type;

export const isShutdownResult = Schema.is(ShutdownResult);
