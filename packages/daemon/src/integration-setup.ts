/** Durable setup of a disposable integration checkout; never rejects reviewed work. */
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import { executeAfterCreate } from "./after-create.js";
import { beginOperation, recordOperationResult } from "./operations.js";
import type { Operation } from "./operations.js";
import type { Store } from "./store.js";

export const runIntegrationSetup = (store: Store, integration: Operation, argv: ReadonlyArray<string>, path: string,
  clonePath: string, env: NodeJS.ProcessEnv) => Effect.gen(function* () {
  const directory = yield* Effect.sync(() => mkdtempSync(resolve(clonePath, "..", `foundry-setup-${integration.id}-`)));
  const logPath = join(directory, "after-create.log");

  const hook = yield* beginOperation(store, { factoryId: integration.factoryId, ticket: expectDefined(integration.ticket ?? undefined, "integration ticket"), kind: "hook",
    intent: { hook: "after_create", operation: "integration", integrationOperationId: integration.id, argv: [...argv], path, logPath } });

  const result = yield* Effect.promise((signal) => executeAfterCreate(argv, path, logPath, env, signal));
  const passed = result.exitStatus === 0 && result.signal === null && result.reason === null;
  const evidence = { hook: "after_create", operation: "integration", operationId: hook.id, ...result, logPath };

  yield* store.change((change) => recordOperationResult(change, hook.id, { status: passed ? "complete" : "failed", result: evidence }));

  return { status: passed ? "passed" : "failed", ...evidence };
});
