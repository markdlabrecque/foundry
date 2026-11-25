/** Thin management client. Force reads losses, confirms, then acts on that exact inspection. */
import { createInterface } from "node:readline/promises";
import { messageOf } from "@foundry/protocol/errors";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { isFailedWorktreeInspection, isWorktreeCleanResult, isWorktreeInspection, isWorktreeListResult, isWorktreeRecreateResult, WORKTREES_PATH, worktreeFailedPath, worktreePath } from "@foundry/protocol/worktrees-api";
import type { WorktreeCleanRequest, WorktreeDiscardRequest, WorktreeRecreateResult } from "@foundry/protocol/worktrees-api";
import { DaemonUnreachableError, getFromDaemon, postToDaemon } from "./management-client.js";
import type { ApiReply } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

interface WorktreeOptions {
  readonly home: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly factory: string | undefined;
  readonly json: boolean;
}

interface WorktreeCleanOptions extends WorktreeOptions {
  readonly number: number;
  readonly force: boolean;
  readonly yes: boolean;
  readonly terminal?: boolean;
  readonly confirm?: (losses: string) => Promise<boolean>;
  /** Stream the disclosure before acting; stdout remains an untouched JSON envelope. */
  readonly notice?: (losses: string) => void;
}

const refused = (message: string, exitCode: StatusOutcome["exitCode"] = EXIT_REFUSED): StatusOutcome => ({ exitCode, stdout: "", stderr: `foundry: ${message}\n` });

const answer = (reply: ApiReply, json: boolean, output: string | undefined): StatusOutcome => {
  if (json) {return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout: reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`, stderr: "" };}

  if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

  return output === undefined ? refused("the daemon answered with an unexpected shape") : { exitCode: EXIT_OK, stdout: output, stderr: "" };
};

const failure = (cause: unknown) => refused(messageOf(cause), cause instanceof DaemonUnreachableError ? EXIT_UNREACHABLE : EXIT_REFUSED);

export const runWorktreeList = async (options: WorktreeOptions): Promise<StatusOutcome> => {
  if (options.home === "") {return refused("--home needs a directory", EXIT_USAGE);}

  try {
    const query = options.factory === undefined ? "" : `?factory=${encodeURIComponent(options.factory)}`;
    const reply = await getFromDaemon(selectStateRoot(options), `${WORKTREES_PATH}${query}`);
    const result = reply.envelope.ok ? reply.envelope.result : undefined;

    const output = !isWorktreeListResult(result) ? undefined : result.worktrees.length === 0 ? "no ticket worktrees\n"
      : `${result.worktrees.map((w) => `${w.factoryId}  ${w.ticket}  ${w.state}  ${w.path}  ${w.branch}`).join("\n")}\n`;

    return answer(reply, options.json, output);
  } catch (cause) {return failure(cause);}
};

const prompt = async (): Promise<boolean> => {
  const input = createInterface({ input: process.stdin, output: process.stderr });

  try {return (await input.question("Discard this worktree and branch? [y/N] ")).trim().toLowerCase() === "y";}
  finally {input.close();}
};

export const runWorktreeClean = async (options: WorktreeCleanOptions): Promise<StatusOutcome> => {
  if (options.home === "" || !Number.isSafeInteger(options.number) || options.number < 1) {return refused("provide a positive ticket number and valid --home", EXIT_USAGE);}

  const stateRoot = selectStateRoot(options);
  const path = worktreePath(options.number, options.factory);

  try {
    let confirmation: string | undefined;

    if (options.force) {
      const inspection = await getFromDaemon(stateRoot, path);

      if (!inspection.envelope.ok) {return answer(inspection, options.json, undefined);}

      if (!isWorktreeInspection(inspection.envelope.result)) {return refused("the daemon answered with an unexpected inspection");}

      const result = inspection.envelope.result;
      const losses = `Remove ${result.path} and branch ${result.branch}\nUncommitted/untracked files:\n${result.files || "(none)"}\nUnmerged commits:\n${result.commits || "(none)"}\n`;

      (options.notice ?? ((text: string) => { process.stderr.write(text); }))(losses);

      if (!options.yes) {
        if (!(options.terminal ?? process.stdin.isTTY === true)) {return refused("--force requires a terminal or --yes; nothing removed", EXIT_USAGE);}

        if (!await (options.confirm ?? prompt)(losses)) {return refused("cleanup not confirmed; nothing removed", EXIT_USAGE);}
      }

      confirmation = result.confirmation;
    }

    let body: WorktreeCleanRequest = { force: options.force };

    if (confirmation !== undefined) {body = { ...body, confirmation };}

    const reply = await postToDaemon(stateRoot, path, body);
    const result = reply.envelope.ok ? reply.envelope.result : undefined;

    return answer(reply, options.json, !isWorktreeCleanResult(result) ? undefined : `removed worktree for ${result.factoryId} ticket ${result.ticket} (operation ${result.operationId})\n`);
  } catch (cause) {return failure(cause);}
};

interface FailedWorktreeOptions extends WorktreeOptions {
  readonly number: number;
}

interface WorktreeDiscardOptions extends FailedWorktreeOptions {
  readonly yes: boolean;
  readonly terminal?: boolean;
  readonly confirm?: (losses: string) => Promise<boolean>;
  /** Stream the disclosure before acting; stdout remains an untouched JSON envelope. */
  readonly notice?: (losses: string) => void;
}

// Creation and its first after_create run before the daemon answers.
const RECREATE_TIMEOUT_MS = 10 * 60 * 1000;

const recreated = (verb: string) => (result: WorktreeRecreateResult): string =>
  `${verb} worktree for ${result.factoryId} ticket ${result.ticket} at ${result.path} on ${result.branch} (operation ${result.operationId})\n`;

const invalidTicket = (options: FailedWorktreeOptions): StatusOutcome | undefined =>
  options.home === "" || !Number.isSafeInteger(options.number) || options.number < 1
    ? refused("provide a positive ticket number and valid --home", EXIT_USAGE) : undefined;

/** `foundry worktree retry <n>`: create a failed ticket worktree again, deleting nothing. */
export const runWorktreeRetry = async (options: FailedWorktreeOptions): Promise<StatusOutcome> => {
  const invalid = invalidTicket(options);

  if (invalid !== undefined) {return invalid;}

  try {
    const reply = await postToDaemon(selectStateRoot(options), worktreeFailedPath(options.number, "retry", options.factory), {},
      { timeoutMs: RECREATE_TIMEOUT_MS });

    const result = reply.envelope.ok ? reply.envelope.result : undefined;

    return answer(reply, options.json, isWorktreeRecreateResult(result) ? recreated("created")(result) : undefined);
  } catch (cause) {return failure(cause);}
};

const discardPrompt = async (): Promise<boolean> => {
  const input = createInterface({ input: process.stdin, output: process.stderr });

  try {return (await input.question("Discard this partial worktree and branch? [y/N] ")).trim().toLowerCase() === "y";}
  finally {input.close();}
};

/**
 * `foundry worktree discard <n>`: remove a failed creation's partial worktree and branch, then
 * create both again from the default branch. Commits or files are shown and need confirmation.
 */
export const runWorktreeDiscard = async (options: WorktreeDiscardOptions): Promise<StatusOutcome> => {
  const invalid = invalidTicket(options);

  if (invalid !== undefined) {return invalid;}

  const stateRoot = selectStateRoot(options);

  try {
    const inspection = await getFromDaemon(stateRoot, worktreeFailedPath(options.number, undefined, options.factory));

    if (!inspection.envelope.ok) {return answer(inspection, options.json, undefined);}

    if (!isFailedWorktreeInspection(inspection.envelope.result)) {return refused("the daemon answered with an unexpected inspection");}

    const result = inspection.envelope.result;
    let body: WorktreeDiscardRequest = {};

    if (result.needsConfirmation) {
      const losses = `Discard ${result.path} and branch ${result.branch}\nUncommitted/untracked files:\n${result.files || "(none)"}\nUnmerged commits:\n${result.commits || "(none)"}\n`;

      (options.notice ?? ((text: string) => { process.stderr.write(text); }))(losses);

      if (!options.yes) {
        if (!(options.terminal ?? process.stdin.isTTY === true)) {return refused("discarding commits or files requires a terminal or --yes; nothing removed", EXIT_USAGE);}

        if (!await (options.confirm ?? discardPrompt)(losses)) {return refused("discard not confirmed; nothing removed", EXIT_USAGE);}
      }

      body = { confirmation: result.confirmation };
    }

    const reply = await postToDaemon(stateRoot, worktreeFailedPath(options.number, "discard", options.factory), body,
      { timeoutMs: RECREATE_TIMEOUT_MS });

    const done = reply.envelope.ok ? reply.envelope.result : undefined;

    return answer(reply, options.json, isWorktreeRecreateResult(done) ? recreated("recreated")(done) : undefined);
  } catch (cause) {return failure(cause);}
};
