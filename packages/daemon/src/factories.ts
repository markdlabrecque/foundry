/**
 * The factory list (PRD §11.2, §13.1), read from daemon state: the run this daemon serves and the
 * configuration loads recorded for it at start (`factory-loads.ts`). Nothing here re-reads YAML.
 */
import { Effect } from "effect";
import type { FactoryListResult, FactoryState, FactorySummary } from "@foundry/protocol/factories-api";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Store, StoreError } from "./store.js";

interface LoadRow {
  readonly id: number;
  readonly factory_id: string;
  readonly yaml_file: string;
  readonly config_hash: string;
  readonly knowledge_root: string;
}

/** Thrown into the API's 500 path when the run being served was never recorded. */
export class RunNotRecordedError extends Error {
  override readonly name = "RunNotRecordedError";
}

/**
 * The factories loaded in run `runId`, in load order. Fails if the run has no record. `stateOf`
 * gives each factory's state in this run; one it does not know is `running`.
 */
export const listLoadedFactories = (
  store: Store,
  runId: string,
  stateOf: (factoryId: string) => FactoryState | undefined = () => undefined,
): Effect.Effect<FactoryListResult, StoreError | RunNotRecordedError> =>
  Effect.gen(function* () {
    const runs = yield* store.read<{ started_at: number }>(`SELECT started_at FROM run WHERE id = ?`, [runId]);
    const run = runs[0];

    if (run === undefined) {return yield* Effect.fail(new RunNotRecordedError(`run ${runId} is not recorded`));}

    const rows = yield* store.read<LoadRow>(
      `SELECT id, factory_id, yaml_file, config_hash, knowledge_root
       FROM factory_config_load WHERE run_id = ? ORDER BY id`,
      [runId],
    );

    const factories = rows.map(
      (row): FactorySummary => ({
        factoryId: row.factory_id,
        // A stop changes the state for this run only; the next daemon start runs the factory again.
        state: stateOf(row.factory_id) ?? "running",
        loadId: row.id,
        yamlFile: row.yaml_file,
        configHash: row.config_hash,
        knowledgeRoot: row.knowledge_root,
      }),
    );

    return { runId, loadedAt: new Date(run.started_at).toISOString(), factories };
  });

/** What the management API serves for `GET /api/v1/factories`. */
export interface FactoriesReader {
  readonly list: () => Promise<FactoryListResult>;
}

/** Serves the factories of run `runId` from the store, read afresh on each request. */
export const storeFactoriesReader = (
  store: Store,
  runId: string,
  stateOf?: (factoryId: string) => FactoryState | undefined,
): FactoriesReader => ({
  list: () => Effect.runPromise(listLoadedFactories(store, runId, stateOf)),
});
