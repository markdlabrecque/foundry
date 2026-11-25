/** Shared, intent-first ticket worktree removal. Cancellation itself never calls this service. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "@foundry/protocol/errors";
import type { WorktreeInspection, WorktreeSummary } from "@foundry/protocol/worktrees-api";
import { Effect } from "effect";
import { runCloneGit } from "./factory-clone.js";
import type { TicketWorktreesOptions } from "./worktrees.js";
import { beginOperationIn, recordOperationResult } from "./operations.js";
import { ticketRecord } from "./history-records.js";
import { TicketError } from "./tickets.js";

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

export const createWorktreeService = (options: TicketWorktreesOptions & { readonly factories: () => ReadonlyArray<string> }) => {
  const git = (cwd: string, args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(args, options.env ?? process.env, cwd),
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
    const files = yield* git(item.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
    const commits = yield* git(target.clonePath, ["log", "--format=%H %s", `${base}..${head}`, "--"]);
    const diff = yield* git(item.path, ["diff", "--binary", "HEAD", "--"]);
    const staged = yield* git(item.path, ["diff", "--cached", "--binary", "--"]);
    const untracked = yield* git(item.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const ignored = yield* git(item.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);

    const contents = yield* Effect.try({
      try: () => {
        const hash = createHash("sha256");

        for (const name of `${untracked}${ignored}`.split("\0").filter((name) => name !== "")) {
          const file = join(item.path, name);
          const stat = lstatSync(file);
          hash.update(name).update(String(stat.mode));
          hash.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
        }

        return hash.digest("hex");
      },
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

  const clean = (factory: string | undefined, number: number, force = false, confirmation?: string) => Effect.gen(function* () {
    const row = yield* select(factory, number);
    const target = options.target(row.factory_id);

    if (target === undefined) {return yield* refuse("factory clone unavailable");}

    // The claim and eligibility check serialize duplicate requests before any Git action.
    const operation = yield* options.store.change((change) => Effect.gen(function* () {
      const eligible = yield* change.query(`SELECT 1 FROM ticket t WHERE factory_id = ? AND number = ?
        AND state IN ('completed', 'cancelled') AND worktree_path = ? AND branch = ?
        AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.factory_id = t.factory_id AND a.ticket_number = t.number AND a.status <> 'ended')
        AND NOT EXISTS (SELECT 1 FROM operation o WHERE o.factory_id = t.factory_id AND o.ticket_number = t.number
          AND o.kind = 'cleanup' AND o.status IN ('running', 'interrupted', 'indeterminate'))`,
      [row.factory_id, row.number, row.worktree_path, row.branch]);

      if (eligible.length === 0) {return yield* refuse("only inactive completed or cancelled worktrees can be cleaned; cleanup may already be pending");}

      return yield* beginOperationIn(change, { factoryId: row.factory_id, kind: "cleanup", ticket: number,
        intent: { path: row.worktree_path, branch: row.branch, clonePath: target.clonePath, force } });
    }));

    let removed = false;

    return yield* Effect.gen(function* () {
      const inspected = yield* inspectRow(row);

      if (force) {
        if (confirmation !== inspected.confirmation) {return yield* refuse("force requires confirmation of the current files and unmerged commits; inspect again");}
      } else {
        if (inspected.files !== "" || inspected.commits !== "") {return yield* refuse("worktree contains uncommitted/untracked files or unmerged commits; inspect and confirm --force to discard them");}

        // Hook execution is a separate lifecycle handler (FOU-78); never silently bypass it.
        if (target.factory.config.worktrees?.before_remove !== undefined) {return yield* refuse("before_remove hook requires the hook lifecycle handler; use confirmed --force to skip it");}
      }

      yield* git(target.clonePath, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", ...(force ? ["--force"] : []), "--", inspected.path]);
      removed = true;
      yield* git(target.clonePath, ["-c", "core.hooksPath=/dev/null", "branch", "-D", "--", inspected.branch]);
      yield* options.store.change((change) => Effect.gen(function* () {
        yield* change.query(`UPDATE ticket SET worktree_path = NULL, branch = NULL WHERE factory_id = ? AND number = ?`, [row.factory_id, number]);
        yield* recordOperationResult(change, operation.id, { status: "complete", result: { path: inspected.path, branch: inspected.branch } });
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

  return { list, inspect, clean };
};

export type WorktreeService = ReturnType<typeof createWorktreeService>;
