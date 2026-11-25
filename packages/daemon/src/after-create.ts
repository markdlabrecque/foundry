/** First-worktree hook execution. Intent is committed with worktree creation, before spawning. */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { messageOf } from "@foundry/protocol/errors";
import { Clock, Effect } from "effect";
import { ticketRecord } from "./history-records.js";
import { raiseHoldIn } from "./holds.js";
import { recordOperationResult } from "./operations.js";
import type { Operation } from "./operations.js";
import type { QueuedTicket } from "./assignments.js";
import type { Store } from "./store.js";

interface HookResult {
  readonly exitStatus: number | null;
  readonly signal: string | null;
  readonly reason: string | null;
}

/** Stream both outputs to disk, not an unbounded in-memory buffer. No shell is involved. */
const execute = (argv: ReadonlyArray<string>, cwd: string, logPath: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HookResult> =>
  new Promise((resolve) => {
    let fd: number | undefined;

    const finish = (result: HookResult) => {
      if (fd !== undefined) {closeSync(fd);}

      resolve(result);
    };

    try {
      mkdirSync(dirname(logPath), { recursive: true });
      fd = openSync(logPath, "wx", 0o600);
      const command = argv[0];

      if (command === undefined) {throw new Error("after_create command is empty");}

      const child = spawn(command, argv.slice(1), { cwd, env, shell: false, signal, killSignal: "SIGKILL", stdio: ["ignore", fd, fd] });
      let reason: string | null = null;
      child.on("error", (error) => {
        reason = messageOf(error);

        if (fd !== undefined) {writeSync(fd, `\n${reason}\n`);}
      });
      child.on("close", (exitStatus, signal) => finish({ exitStatus: reason === null ? exitStatus : null, signal, reason }));
    } catch (cause) {
      const reason = messageOf(cause);

      if (fd !== undefined) {writeSync(fd, `\n${reason}\n`);}

      finish({ exitStatus: null, signal: null, reason });
    }
  });

export const runFirstAfterCreate = (options: {
  readonly store: Store;
  readonly operation: Operation;
  readonly ticket: QueuedTicket;
  readonly stage: string;
  readonly argv: ReadonlyArray<string>;
  readonly path: string;
  readonly logPath: string;
  readonly env: NodeJS.ProcessEnv;
}) => Effect.gen(function* () {
  const { store, operation, ticket, stage, argv, path, logPath, env } = options;
  const result = yield* Effect.promise((signal) => execute(argv, path, logPath, env, signal));
  const succeeded = result.exitStatus === 0 && result.reason === null;

  yield* store.change((change) => Effect.gen(function* () {
    yield* recordOperationResult(change, operation.id, {
      status: succeeded ? "complete" : "failed", result: { ...result, logPath },
    });

    if (succeeded) {return;}

    // Cancellation during the hook is final; never revive it as a paused ticket.
    const rows = yield* change.query<QueuedTicket>(
      `SELECT * FROM ticket WHERE factory_id = ? AND number = ? AND (state = 'backlog' OR (state = 'stage' AND status = 'queued'))`,
      [ticket.factory_id, ticket.number],
    );

    const current = rows[0];

    if (current === undefined) {return;}

    const now = yield* Clock.currentTimeMillis;

    yield* change.query(`UPDATE ticket SET state = 'stage', stage = ?, status = 'paused' WHERE factory_id = ? AND number = ?`,
      [stage, ticket.factory_id, ticket.number]);
    yield* change.query(
      `INSERT INTO ticket_transition (factory_id, ticket_number, recorded_at, actor, from_state, from_stage,
        from_status, to_state, to_stage, to_status, reason) VALUES (?, ?, ?, 'daemon', ?, ?, ?, 'stage', ?, 'paused', ?)`,
      [ticket.factory_id, ticket.number, now, current.state, current.stage, current.status, stage, "after_create failed"],
    );
    yield* change.recordHistory({ factoryId: ticket.factory_id, kind: "ticket.paused", subject: String(ticket.number),
      detail: { reason: "after_create failed", operationId: operation.id, logPath }, records: [ticketRecord(ticket.number)] });
    yield* raiseHoldIn(change, { factoryId: ticket.factory_id, kind: "hook_failure", subject: String(ticket.number),
      evidence: { hook: "after_create", operation: "worktree_create", operationId: operation.id, ...result, logPath } });
  }));
});
