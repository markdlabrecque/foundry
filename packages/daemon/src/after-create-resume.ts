/** Operator retry of a failed first-worktree setup, before a worker can use that worktree. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { runFirstAfterCreate } from "./after-create.js";
import type { QueuedTicket } from "./assignments.js";
import { beginOperationIn } from "./operations.js";
import type { Store } from "./store.js";

class NoHookRetry extends Data.TaggedError("NoHookRetry") {}

const decodeIntent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.String), worktreeOperationId: Schema.Number,
})));

/** Claim in one transaction; keep the ticket paused until the new hook result commits. */
export const resumeFirstAfterCreate = (store: Store, factory: string, number: number, configLoad?: string) => Effect.gen(function* () {
  const retry = yield* store.change((change) => Effect.gen(function* () {
    const [ticket] = yield* change.query<QueuedTicket>(
      `SELECT * FROM ticket t WHERE factory_id = ? AND number = ? AND state = 'stage' AND status = 'paused'
       AND worktree_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assignment a
         WHERE a.factory_id = t.factory_id AND a.ticket_number = t.number AND a.status IN ('active', 'suspended'))`,
      [factory, number],
    );

    if (ticket === undefined || ticket.stage === null || ticket.worktree_path === null) {return yield* new NoHookRetry();}

    const [previous] = yield* change.query<{ id: number; status: string; intent: string }>(
      `SELECT id, status, intent FROM operation WHERE factory_id = ? AND ticket_number = ? AND kind = 'hook'
       AND json_extract(intent, '$.hook') = 'after_create' AND json_extract(intent, '$.operation') = 'worktree_create'
       ORDER BY id DESC LIMIT 1`, [factory, number],
    );

    const [hold] = yield* change.query(`SELECT id FROM operator_hold WHERE factory_id = ? AND subject = ?
      AND kind = 'hook_failure' AND state = 'open' AND json_extract(evidence, '$.operationId') = ?`,
    [factory, String(number), previous?.id ?? null]);

    if (previous?.status !== 'failed' || hold === undefined) {return yield* new NoHookRetry();}

    const { argv, worktreeOperationId } = decodeIntent(previous.intent);
    const logPath = join(ticket.directory, 'evidence', `after-create-${randomUUID()}.log`);

    const operation = yield* beginOperationIn(change, { factoryId: factory, kind: 'hook', ticket: number,
      intent: { hook: 'after_create', operation: 'worktree_create', worktreeOperationId,
        retryOf: previous.id, argv, path: ticket.worktree_path, logPath } });

    return { ticket, stage: ticket.stage, path: ticket.worktree_path, argv, logPath, operation };
  })).pipe(Effect.catchTag('NoHookRetry', () => Effect.succeed(undefined)));

  if (retry === undefined) {return false;}

  yield* runFirstAfterCreate({ store, ...retry, env: process.env, resume: true, configLoad });

  return true;
});
