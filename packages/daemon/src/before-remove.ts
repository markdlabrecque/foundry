/** Intent-first before_remove execution. Output lives outside the worktree it may remove. */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "@foundry/protocol/errors";
import { Effect } from "effect";
import { closeOpenHoldIn, raiseHoldIn } from "./holds.js";
import { beginOperationIn, extendOperationIntent, recordOperationResult } from "./operations.js";
import type { Store } from "./store.js";
import { TicketError } from "./tickets.js";

interface HookOptions {
  readonly store: Store;
  readonly stateRoot: string;
  readonly factoryId: string;
  readonly ticket: number;
  readonly path: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

interface HookExit {
  readonly exitStatus: number | null;
  readonly signal: string | null;
  readonly error: string | null;
}

/** Direct argv, no shell; file descriptors bound memory even for verbose cleanup commands. */
const execute = async (options: HookOptions, logPath: string): Promise<HookExit> => {
  let fd: number | undefined;

  try {
    mkdirSync(join(options.stateRoot, "logs", "operations"), { recursive: true });
    fd = openSync(logPath, "wx", 0o600);
    const command = options.argv[0];

    if (command === undefined) {throw new Error("before_remove command is empty");}

    const outcome = await new Promise<HookExit>((resolve) => {
      const child = spawn(command, options.argv.slice(1), { cwd: options.path, env: options.env, shell: false, stdio: ["ignore", fd, fd] });
      let error: string | null = null;
      child.on("error", (cause) => { error = messageOf(cause); });
      child.on("close", (exitStatus, signal) => { resolve({ exitStatus, signal, error }); });
    });

    if (outcome.error !== null) {writeSync(fd, `${outcome.error}\n`);}

    return outcome;
  } catch (cause) {
    const error = messageOf(cause);

    if (fd !== undefined) {writeSync(fd, `${error}\n`);}

    return { exitStatus: null, signal: null, error };
  } finally {
    if (fd !== undefined) {closeSync(fd);}
  }
};

export const runBeforeRemove = (options: HookOptions) => Effect.gen(function* () {
  const hold = { factoryId: options.factoryId, kind: "hook_failure", subject: String(options.ticket) } as const;

  const operation = yield* options.store.change((change) => Effect.gen(function* () {
    // A retry resolves the previous failure; another failure must raise a fresh hold.
    yield* closeOpenHoldIn(change, hold, "resolved");

    return yield* beginOperationIn(change, { factoryId: options.factoryId, kind: "hook", ticket: options.ticket,
      intent: { hook: "before_remove", argv: [...options.argv], path: options.path } });
  }));

  const logPath = join(options.stateRoot, "logs", "operations", `${operation.id}.log`);
  yield* extendOperationIntent(options.store, operation.id, { logPath });
  const outcome = yield* Effect.promise(() => execute(options, logPath));
  const failed = outcome.exitStatus !== 0 || outcome.signal !== null || outcome.error !== null;

  yield* options.store.change((change) => Effect.gen(function* () {
    yield* recordOperationResult(change, operation.id, { status: failed ? "failed" : "complete", result: { ...outcome, logPath } });

    if (failed) {
      yield* raiseHoldIn(change, { ...hold, evidence: { hook: "before_remove", operationId: operation.id, ...outcome, logPath } });
    }
  }));

  if (failed) {
    return yield* new TicketError({ code: "invalid_state",
      message: `before_remove failed (operation ${operation.id}, exit ${outcome.exitStatus}, signal ${outcome.signal}${outcome.error === null ? "" : `, ${outcome.error}`}); worktree preserved; log: ${logPath}` });
  }
});
