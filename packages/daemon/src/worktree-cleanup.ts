/** Shared, intent-first ticket worktree removal. Cancellation itself never calls this service. */
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "@foundry/protocol/errors";
import type { WorktreeInspection, WorktreeSummary } from "@foundry/protocol/worktrees-api";
import { Effect } from "effect";
import { runCloneGit } from "./factory-clone.js";
import type { TicketWorktreesOptions } from "./worktrees.js";
import { beginOperationIn, recordOperationResult, recordRecoveryResultIn } from "./operations.js";
import type { Operation } from "./operations.js";
import { ticketRecord } from "./history-records.js";
import { runBeforeRemove } from "./before-remove.js";
import type { HookLogIo } from "./before-remove.js";
import { closeOpenHoldIn } from "./holds.js";
import { TicketError } from "./tickets.js";
import { createFailedWorktreeActions } from "./worktree-retry.js";

interface WorktreeRow {
  readonly factory_id: string;
  readonly number: number;
  readonly state: string;
  readonly worktree_path: string | null;
  readonly branch: string | null;
}

const refuse = (message: string) => new TicketError({ code: "invalid_state", message });

const summary = (row: WorktreeRow): WorktreeSummary => ({
  factoryId: row.factory_id, ticket: row.number, state: row.state,
  path: row.worktree_path ?? "", branch: row.branch ?? "",
});

/** Bound both memory and work; special files are never opened as blocking streams. */
const fingerprintFiles = async (path: string, names: ReadonlyArray<string>): Promise<string> => {
  const hash = createHash("sha256");
  const limit = 16 * 1024 * 1024;
  let bytes = 0;
  let entries = 0;
  const directories = [path];

  // Git may omit FIFOs/devices from both status and ls-files. Inspect entry types independently.
  while (directories.length > 0) {
    const directory = directories.pop();

    if (directory === undefined) {break;}

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === path && entry.name === ".git") {continue;}

      entries += 1;

      if (entries > 100_000) {throw new Error("filesystem inspection exceeds the 100000-entry safety limit");}

      if (entry.isDirectory()) {directories.push(join(directory, entry.name));}
      else if (!entry.isFile() && !entry.isSymbolicLink()) {throw new Error(`unsupported filesystem entry ${JSON.stringify(join(directory, entry.name))}; preserve and remove it manually`);}
    }
  }

  for (const name of names) {
    const file = join(path, name);
    const stat = await lstat(file);
    hash.update(name).update(String(stat.mode));

    if (stat.isSymbolicLink()) {
      hash.update(await readlink(file));
      continue;
    }

    if (!stat.isFile()) {throw new Error(`unsupported filesystem entry ${JSON.stringify(name)}; preserve and remove it manually`);}

    if (stat.size > limit - bytes) {throw new Error("file inspection exceeds the 16 MiB safety limit; preserve or reduce the files before cleanup");}

    // Recheck the opened inode, with nonblocking/no-follow flags closing the lstat/open race.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

    try {
      const opened = await handle.stat();

      if (!opened.isFile()) {throw new Error(`unsupported filesystem entry ${JSON.stringify(name)}`);}

      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        if (!Buffer.isBuffer(chunk)) {throw new Error("unexpected file stream encoding");}

        bytes += chunk.length;

        if (bytes > limit) {throw new Error("file inspection exceeds the 16 MiB safety limit");}

        hash.update(chunk);
      }
    } finally {await handle.close();}
  }

  return hash.digest("hex");
};

export const createWorktreeService = (options: TicketWorktreesOptions & { readonly stateRoot: string; readonly hookLogIo?: HookLogIo | undefined; readonly factories: () => ReadonlyArray<string> }) => {
  const git = (cwd: string, args: ReadonlyArray<string>, rawOutput = false) => Effect.tryPromise({
    try: () => runCloneGit(args, options.env ?? process.env, cwd, rawOutput),
    catch: (cause) => refuse(messageOf(cause)),
  });

  const select = (factory: string | undefined, number: number) => Effect.gen(function* () {
    const names = options.factories();
    const selected = factory ?? (names.length === 1 ? names[0] : undefined);

    if (selected === undefined) {return yield* new TicketError({ code: "factory_required", message: "select a factory with --factory" });}

    if (!names.includes(selected)) {return yield* new TicketError({ code: "unknown_factory", message: `unknown factory ${selected}` });}

    if (!Number.isSafeInteger(number) || number < 1) {return yield* new TicketError({ code: "invalid_request", message: "ticket must be a positive integer" });}

    const rows = yield* options.store.read<WorktreeRow>(`SELECT factory_id, number, state, worktree_path, branch FROM ticket WHERE factory_id = ? AND number = ?`, [selected, number]);
    const row = rows[0];

    if (row === undefined) {return yield* new TicketError({ code: "ticket_not_found", message: `no ticket ${number} in ${selected}` });}

    if (row.worktree_path === null || row.branch === null) {return yield* refuse("ticket has no worktree");}

    return row;
  });

  const inspectRow = (row: WorktreeRow) => Effect.gen(function* () {
    const target = options.target(row.factory_id);

    if (target === undefined) {return yield* refuse("factory clone unavailable");}

    const item = summary(row);
    const defaultBranch = target.factory.config.repository.default_branch;

    const paths = yield* Effect.try({
      try: () => ({ clone: realpathSync(target.clonePath), path: realpathSync(item.path) }),
      catch: (cause) => refuse(messageOf(cause)),
    });

    const top = yield* git(item.path, ["rev-parse", "--show-toplevel"]);
    const common = yield* git(item.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const cloneCommon = yield* git(target.clonePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const branch = yield* git(item.path, ["symbolic-ref", "--quiet", "HEAD"]);

    const sameRepository = yield* Effect.try({
      try: () => realpathSync(common) === realpathSync(cloneCommon) && realpathSync(top) === paths.path,
      catch: (cause) => refuse(messageOf(cause)),
    });

    if (!sameRepository || paths.path === paths.clone || branch !== `refs/heads/${item.branch}` || item.branch === defaultBranch) {
      return yield* refuse("worktree identity does not match the recorded ticket; refusing removal");
    }

    const head = yield* git(item.path, ["rev-parse", "HEAD"]);
    const base = yield* git(target.clonePath, ["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`]);
    const status = yield* git(item.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
    const index = yield* git(item.path, ["ls-files", "-v", "-z"], true);
    const hidden = index.split("\0").filter((entry) => /^[a-zS] /.test(entry)).map((entry) => entry.slice(2));
    const files = [status, ...hidden.map((name) => `index flag may hide tracked changes: ${JSON.stringify(name)}`)].filter((line) => line !== "").join("\n");
    const commits = yield* git(target.clonePath, ["log", "--format=%H %s", `${base}..${head}`, "--"]);
    const diff = yield* git(item.path, ["diff", "--binary", "HEAD", "--"]);
    const staged = yield* git(item.path, ["diff", "--cached", "--binary", "--"]);
    const untracked = yield* git(item.path, ["ls-files", "--others", "--exclude-standard", "-z"], true);
    const ignored = yield* git(item.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], true);

    const contents = yield* Effect.tryPromise({
      try: () => fingerprintFiles(item.path, [...new Set([...`${untracked}${ignored}`.split("\0").filter((name) => name !== ""), ...hidden])]),
      catch: (cause) => refuse(`cannot inspect all files safely: ${messageOf(cause)}`),
    });

    const confirmation = createHash("sha256").update(JSON.stringify({ item, head, base, files, commits, diff, staged, contents })).digest("hex");

    return { ...item, files, commits, confirmation } satisfies WorktreeInspection;
  });

  const inspect = (factory: string | undefined, number: number) => Effect.flatMap(select(factory, number), inspectRow);

  const list = (factory?: string) => Effect.gen(function* () {
    const rows = yield* options.store.read<WorktreeRow>(
      `SELECT factory_id, number, state, worktree_path, branch FROM ticket WHERE worktree_path IS NOT NULL
       ${factory === undefined ? "" : "AND factory_id = ?"} ORDER BY factory_id, number`, factory === undefined ? [] : [factory],
    );

    return { worktrees: rows.map(summary) };
  });

  /**
   * `recovering`: an interrupted cleanup (and its interrupted before_remove runs) that this run
   * replaces. They are closed in the same change that claims the rerun (PRD §10.2), so a second
   * crash leaves exactly one cleanup awaiting recovery.
   */
  const cleanRow = (row: WorktreeRow, force: boolean, confirmation: string | undefined,
    recovering?: { readonly cleanup: Operation; readonly hooks: ReadonlyArray<Operation> }) => Effect.gen(function* () {
    const number = row.number;
    const target = options.target(row.factory_id);

    if (target === undefined) {return yield* refuse("factory clone unavailable");}

    // The claim and eligibility check serialize duplicate requests before any Git action.
    const operation = yield* options.store.change((change) => Effect.gen(function* () {
      const eligible = yield* change.query(`SELECT 1 FROM ticket t WHERE factory_id = ? AND number = ?
        AND state IN ('completed', 'cancelled') AND worktree_path = ? AND branch = ?
        AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.factory_id = t.factory_id AND a.ticket_number = t.number AND a.status <> 'ended')
        AND NOT EXISTS (SELECT 1 FROM operation o WHERE o.factory_id = t.factory_id AND o.ticket_number = t.number
          AND o.kind = 'cleanup' AND o.id <> ?
          AND (o.status IN ('running', 'indeterminate') OR (o.status = 'interrupted' AND o.result IS NULL)))`,
      [row.factory_id, row.number, row.worktree_path, row.branch, recovering?.cleanup.id ?? -1]);

      if (eligible.length === 0) {return yield* refuse("only inactive completed or cancelled worktrees can be cleaned; cleanup may already be pending");}

      const begun = yield* beginOperationIn(change, { factoryId: row.factory_id, kind: "cleanup", ticket: number,
        intent: { path: row.worktree_path, branch: row.branch, clonePath: target.clonePath, force } });

      for (const replaced of recovering === undefined ? [] : [recovering.cleanup, ...recovering.hooks]) {
        yield* recordRecoveryResultIn(change, replaced.id, { status: "interrupted", result: { rerunAs: begun.id } });
      }

      return begun;
    }));

    let removed = false;

    return yield* Effect.gen(function* () {
      const inspected = yield* inspectRow(row);

      if (force) {
        if (confirmation !== inspected.confirmation) {return yield* refuse("force requires confirmation of the current files and unmerged commits; inspect again");}
      } else {
        if (inspected.files !== "" || inspected.commits !== "") {return yield* refuse("worktree contains uncommitted/untracked files or unmerged commits; inspect and confirm --force to discard them");}

        const argv = target.factory.config.worktrees?.before_remove;

        if (argv !== undefined) {
          yield* runBeforeRemove({ store: options.store, stateRoot: options.stateRoot,
            factoryId: row.factory_id, ticket: number, path: inspected.path, argv, env: options.env ?? process.env, logIo: options.hookLogIo });
          // Hooks can change files or Git state. Never discard newly-created work or a changed identity.
          const afterHook = yield* inspectRow(row);

          if (afterHook.files !== "" || afterHook.commits !== "") {return yield* refuse("before_remove left uncommitted/untracked files or unmerged commits; inspect and confirm --force to discard them");}
        }
      }

      yield* git(target.clonePath, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", ...(force ? ["--force"] : []), "--", inspected.path]);
      removed = true;
      yield* git(target.clonePath, ["-c", "core.hooksPath=/dev/null", "branch", "-D", "--", inspected.branch]);
      yield* options.store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET worktree_path = NULL, branch = NULL WHERE factory_id = ? AND number = ?`, [row.factory_id, number]);
        yield* recordOperationResult(change, operation.id, { status: "complete", result: { path: inspected.path, branch: inspected.branch } });
        yield* closeOpenHoldIn(change, { factoryId: row.factory_id, kind: "hook_failure", subject: String(number) }, "resolved");
        yield* change.recordHistory({ factoryId: row.factory_id, kind: "ticket.worktree_removed", subject: String(number),
          detail: { path: inspected.path, branch: inspected.branch, force }, records: [ticketRecord(number)] });
      }));

      return { factoryId: row.factory_id, ticket: number, operationId: operation.id };
    }).pipe(Effect.catchTag("TicketError", (error) => Effect.gen(function* () {
      yield* options.store.change((change) => recordOperationResult(change, operation.id, {
        status: removed ? "indeterminate" : "failed", result: { reason: error.message, worktreeRemoved: removed },
      }));

      return yield* error;
    })));
  });

  const clean = (factory: string | undefined, number: number, force = false, confirmation?: string) =>
    Effect.flatMap(select(factory, number), (row) => cleanRow(row, force, confirmation));

  /**
   * Reruns an interrupted cleanup whose worktree still exists, with its recorded `force`, rerunning
   * before_remove when it applies. A forced rerun has no fresh confirmation, so it refuses until
   * the operator inspects and confirms again.
   */
  const rerun = (cleanup: Operation, hooks: ReadonlyArray<Operation>) => Effect.gen(function* () {
    if (cleanup.ticket === null) {return yield* refuse(`cleanup operation ${cleanup.id} names no ticket`);}

    const row = yield* select(cleanup.factoryId, cleanup.ticket);

    if (row.worktree_path !== cleanup.intent["path"] || row.branch !== cleanup.intent["branch"]) {
      return yield* refuse("ticket no longer records the interrupted cleanup's worktree");
    }

    return yield* cleanRow(row, cleanup.intent["force"] === true, undefined, { cleanup, hooks });
  });

  // A failed creation (failed-worktree hold): `foundry worktree retry | discard` (worktree-retry.ts).
  const failed = createFailedWorktreeActions(options);

  return { list, inspect, clean, rerun, ...failed };
};

export type WorktreeService = ReturnType<typeof createWorktreeService>;
