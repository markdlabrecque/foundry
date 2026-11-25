/** Durable setup of a disposable integration checkout; never rejects reviewed work. */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { expectDefined } from "@foundry/protocol/errors";
import { executeAfterCreate } from "./after-create.js";
import { beginOperation, recordOperationResult } from "./operations.js";
import type { Operation } from "./operations.js";
import type { Store } from "./store.js";

export const runIntegrationSetup = (store: Store, integration: Operation, argv: ReadonlyArray<string>, path: string,
  clonePath: string, env: NodeJS.ProcessEnv) => Effect.gen(function* () {
  // Choose the path without touching disk. The runner creates it after intent commits,
  // and turns mkdir/open failures into the same evidence as command failures.
  const directory = resolve(clonePath, "..", `foundry-setup-${integration.id}-${randomUUID()}`);
  const logPath = join(directory, "after-create.log");

  const hook = yield* beginOperation(store, { factoryId: integration.factoryId, ticket: expectDefined(integration.ticket ?? undefined, "integration ticket"), kind: "hook",
    intent: { hook: "after_create", operation: "integration", integrationOperationId: integration.id, argv: [...argv], path, logPath } });

  const result = yield* Effect.promise((signal) => executeAfterCreate(argv, path, logPath, env, signal));
  const passed = result.exitStatus === 0 && result.signal === null && result.reason === null;
  const evidence = { hook: "after_create", operation: "integration", operationId: hook.id, ...result, logPath };

  // Failure causes a ticket pause and hold: the integration owner commits those and
  // this hook result together. Successful setup has no ticket-state consequences.
  if (passed) {yield* store.change((change) => recordOperationResult(change, hook.id, { status: "complete", result: evidence }));}

  return { status: passed ? "passed" : "failed", ...evidence };
});
