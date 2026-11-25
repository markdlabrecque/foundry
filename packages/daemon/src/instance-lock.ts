import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The lock file's name inside the state root. */
export const LOCK_FILE_NAME = "daemon.lock";

/** Refusal to claim a state root another live daemon owns. */
export class StateRootLockedError extends Error {
  override readonly name = "StateRootLockedError";
  constructor(
    readonly stateRoot: string,
    readonly lockPath: string,
    readonly ownerPid: number | undefined,
  ) {
    super(
      ownerPid === undefined
        ? `state root ${stateRoot} is locked: ${lockPath} exists but does not name an owner; remove it if no daemon is running`
        : `state root ${stateRoot} is locked by a running daemon (pid ${ownerPid})`,
    );
  }
}

/** An exclusive claim on a state root, held until released. */
export interface StateRootClaim {
  readonly stateRoot: string;
  readonly lockPath: string;
  /** Remove the lock if it is still ours. Safe to call more than once. */
  readonly release: () => void;
}

interface LockContent {
  readonly pid: number;
  readonly startedAt: string;
}

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const readLock = (lockPath: string): { raw: string; owner: LockContent | undefined } | undefined => {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
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
 * Claim the state root exclusively for this process (PRD §3, §11.6).
 *
 * The lock file is published atomically with `link`, so it is never seen empty. A lock whose
 * owner process is gone is stale and is reclaimed; a lock held by a live process, or one that
 * names no owner, refuses the claim with {@link StateRootLockedError}.
 */
export const claimStateRoot = (stateRoot: string): StateRootClaim => {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(stateRoot, LOCK_FILE_NAME);
  const content = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockContent)}\n`;
  const tempPath = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, { mode: 0o600 });
  try {
    // Bounded: each pass either claims, refuses, or removes one stale lock.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tempPath, lockPath);
        return { stateRoot, lockPath, release: releaser(lockPath, content) };
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      const existing = readLock(lockPath);
      if (existing === undefined) continue; // Released between our link and read; try again.
      if (existing.owner === undefined || isProcessAlive(existing.owner.pid)) {
        throw new StateRootLockedError(stateRoot, lockPath, existing.owner?.pid);
      }
      // Stale: remove it only if it is still the lock we judged stale.
      if (readLock(lockPath)?.raw === existing.raw) {
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    }
    const last = readLock(lockPath);
    throw new StateRootLockedError(stateRoot, lockPath, last?.owner?.pid);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Already gone.
    }
  }
};

const releaser = (lockPath: string, content: string) => {
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    if (readLock(lockPath)?.raw !== content) return; // Not ours any more; leave it.
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  };
};
