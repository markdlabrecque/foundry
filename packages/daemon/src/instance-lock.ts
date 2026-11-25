import { randomUUID } from "node:crypto";
import { codeOf } from "@foundry/protocol/errors";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The lock file's name inside the state root. */
export const LOCK_FILE_NAME = "daemon.lock";

/** The guard file held while one process takes over a stale lock. */
export const TAKEOVER_GUARD_FILE_NAME = "daemon.lock.takeover";

/** Why a claim was refused. */
export type StateRootLockedReason =
  /** The lock names a live process. */
  | "held"
  /** The lock exists but names no owner. */
  | "no-owner"
  /** Another process is claiming the root at the same moment. */
  | "contended"
  /** A takeover guard was left by a process that is gone. */
  | "takeover-interrupted";

/** Refusal to claim a state root. */
export class StateRootLockedError extends Error {
  override readonly name = "StateRootLockedError";
  constructor(
    readonly reason: StateRootLockedReason,
    readonly stateRoot: string,
    /** The file the operator would remove to recover, where one applies. */
    readonly path: string,
    readonly ownerPid: number | undefined,
  ) {
    super(describe(reason, stateRoot, path, ownerPid));
  }
}

const describe = (reason: StateRootLockedReason, root: string, path: string, pid: number | undefined): string => {
  switch (reason) {
    case "held":
      return `state root ${root} is locked: pid ${pid} is alive; if it is not a Foundry daemon, remove ${path}`;
    case "no-owner":
      return `state root ${root} is locked: ${path} does not name an owner; remove it if no daemon is running`;
    case "contended":
      return `state root ${root} is being claimed by another process at the same time; retry`;
    case "takeover-interrupted":
      return `state root ${root}: a stale-lock takeover by pid ${pid ?? "unknown"} was interrupted; if no daemon is running, remove ${path}`;
  }
};

/** An exclusive claim on a state root, held until released. */
export interface StateRootClaim {
  readonly stateRoot: string;
  readonly lockPath: string;
  /** Remove the lock if it is still ours. Safe to call more than once. */
  readonly release: () => void;
}

/** Test seam only. */
export interface ClaimStateRootOptions {
  /** Called inside the takeover guard, after a lock was judged stale and before it is removed. */
  readonly onStaleLockConfirmed?: () => void;
}

interface OwnerContent {
  readonly pid: number;
  readonly startedAt: string;
}

interface OwnerFile {
  readonly raw: string;
  readonly owner: OwnerContent | undefined;
}

const isErrno = (cause: unknown, code: string): boolean => codeOf(cause) === code;

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {throw error;}
  }
};

const readOwnerFile = (path: string): OwnerFile | undefined => {
  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {return undefined;}

    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed === "object" && parsed !== null) {
      const { pid, startedAt } = parsed as Record<string, unknown>;

      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startedAt === "string") {
        return { raw, owner: { pid, startedAt } };
      }
    }
  } catch {
    // Fall through: unreadable content names no owner.
  }

  return { raw, owner: undefined };
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return !isErrno(error, "ESRCH");
  }
};

/**
 * Publish `content` at `path` only if nothing is there. Written to a private temporary file and
 * hard-linked into place, so the file is never seen empty or half-written. Returns false if
 * `path` already exists.
 */
const publishExclusive = (path: string, content: string): boolean => {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, content, { mode: 0o600 });

  try {
    linkSync(tempPath, path);

    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) {return false;}

    throw error;
  } finally {
    unlinkIfPresent(tempPath);
  }
};

/** Remove `path` only if it still holds `content`; used for files this process published. */
const removeIfOurs = (path: string, content: string): void => {
  if (readOwnerFile(path)?.raw === content) {unlinkIfPresent(path);}
};

const ownerContent = (): string =>
  `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies OwnerContent)}\n`;

/**
 * Claim the state root exclusively for this process (PRD §3, §11.6).
 *
 * The ordinary claim publishes `daemon.lock` into an empty slot with `link`, which is atomic.
 * A lock whose owner is alive, or that names no owner, refuses the claim.
 *
 * A lock whose owner is gone is stale. Checking it and then removing it is not atomic, so two
 * claimers could each remove the other's fresh lock. Only the holder of the takeover guard, an
 * exclusively published `daemon.lock.takeover`, may remove a stale lock. A concurrent claimer
 * that finds the guard held by a live process is refused as contended. One that finds it left
 * by a dead process is refused with a hint to remove it, because the guard proves nothing about
 * the lock's state.
 */
export const claimStateRoot = (stateRoot: string, options: ClaimStateRootOptions = {}): StateRootClaim => {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(stateRoot, LOCK_FILE_NAME);
  const guardPath = join(stateRoot, TAKEOVER_GUARD_FILE_NAME);
  const content = ownerContent();
  const claimed = (): StateRootClaim => ({ stateRoot, lockPath, release: releaser(lockPath, content) });

  // Bounded: each pass claims, refuses, or makes progress past one changed lock.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (publishExclusive(lockPath, content)) {return claimed();}

    const existing = readOwnerFile(lockPath);

    if (existing === undefined) {continue;} // Released between our link and read.

    if (existing.owner === undefined) {throw new StateRootLockedError("no-owner", stateRoot, lockPath, undefined);}

    if (isProcessAlive(existing.owner.pid)) {
      throw new StateRootLockedError("held", stateRoot, lockPath, existing.owner.pid);
    }

    const guardContent = ownerContent();

    if (!publishExclusive(guardPath, guardContent)) {
      const guard = readOwnerFile(guardPath);

      if (guard === undefined) {continue;} // The other takeover just finished; look again.

      if (guard.owner !== undefined && isProcessAlive(guard.owner.pid)) {
        throw new StateRootLockedError("contended", stateRoot, guardPath, guard.owner.pid);
      }

      throw new StateRootLockedError("takeover-interrupted", stateRoot, guardPath, guard.owner?.pid);
    }

    try {
      // Holding the guard, re-check: the lock may have been replaced since we judged it.
      const current = readOwnerFile(lockPath);

      if (current !== undefined && current.raw !== existing.raw) {continue;}

      if (current !== undefined) {
        options.onStaleLockConfirmed?.();

        // Removal stays conditional so the hook, or anything outside the protocol, cannot make
        // us delete a lock we did not judge stale.
        if (readOwnerFile(lockPath)?.raw !== existing.raw) {continue;}

        unlinkIfPresent(lockPath);
      }

      if (publishExclusive(lockPath, content)) {return claimed();}
      // A fresh claimer took the empty slot first; the next pass sees it as live.
    } finally {
      removeIfOurs(guardPath, guardContent);
    }
  }

  throw new StateRootLockedError("contended", stateRoot, lockPath, readOwnerFile(lockPath)?.owner?.pid);
};

const releaser = (lockPath: string, content: string) => {
  let released = false;

  return (): void => {
    if (released) {return;}

    released = true;
    removeIfOurs(lockPath, content);
  };
};
