/**
 * The dedicated factory clone (PRD §9.1): a clone of `repository.source` that only Foundry uses,
 * created under the state root on a factory's first start and marked as Foundry-owned.
 *
 * - First start: the source is cloned into a temporary sibling, the ownership marker is written
 *   inside its Git directory, and only then is it renamed into place, so anything at the clone
 *   path either carries the marker or was not made by Foundry.
 * - Later starts reuse a marked clone without running Git: the daemon never contacts the source on
 *   its own (sync is a separate operator command).
 * - Anything else at the clone path is refused and left untouched.
 *
 * Git runs with its output captured, never inherited, so the daemon's stderr stays its log.
 * Callers must hold the state-root claim.
 */
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isUrlSource, resolveConfiguredPath } from "./config/index.js";
import type { LoadedFactory } from "./factory-loads.js";
import { pathSegment } from "./tickets.js";

export const CLONES_DIR_NAME = "clones";
/** The ownership marker, inside the clone's `.git` directory where no worker or checkout sees it. */
export const CLONE_MARKER_FILE_NAME = "foundry-clone.json";

/** `<state root>/clones/<factory>`: the factory's clone, one safe path segment per factory name. */
export const factoryClonePath = (stateRoot: string, factory: string): string =>
  join(stateRoot, CLONES_DIR_NAME, pathSegment(factory));

const markerPath = (clone: string): string => join(clone, ".git", CLONE_MARKER_FILE_NAME);

/** What the marker records. */
export interface CloneMarker {
  readonly factory: string;
  /** The source as cloned: a URL, or the absolute local path. */
  readonly source: string;
  /** ISO 8601 time the clone was created. */
  readonly createdAt: string;
}

/** The clone could not be created or reused; refuses start. */
export class FactoryCloneError extends Error {
  override readonly name = "FactoryCloneError";
  constructor(
    readonly factory: string,
    readonly clonePath: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EnsuredClone {
  readonly factory: string;
  readonly path: string;
  /** Whether this start created it, rather than reusing an existing one. */
  readonly created: boolean;
  readonly source: string;
}

/** The configured source as Git should see it: a URL unchanged, a local path made absolute. */
export const cloneSource = (factory: Pick<LoadedFactory, "config" | "yamlFile">, home?: string): string => {
  const source = factory.config.repository.source;
  return isUrlSource(source) ? source : resolveConfiguredPath(source, dirname(factory.yamlFile), home);
};

/** The clone path's own entry, not following a symlink; `undefined` when nothing is there. */
const entryAt = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const readMarker = (clone: string): CloneMarker | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(clone), "utf8")) as Partial<CloneMarker>;
    return typeof parsed.factory === "string" && typeof parsed.source === "string" ? (parsed as CloneMarker) : undefined;
  } catch {
    return undefined;
  }
};

const runGit = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      // Never wait on a credential prompt: the daemon has no terminal.
      { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) return resolve();
        const detail = stderr.trim().split("\n").filter((line) => line !== "").pop();
        reject(new Error(detail ?? error.message));
      },
    );
  });

export interface EnsureCloneOptions {
  readonly stateRoot: string;
  /** Git's environment. Default: the process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** The home directory a leading `~` in a local source expands to. */
  readonly home?: string;
  readonly now?: () => Date;
}

/**
 * Creates the factory's clone on first start, or reuses the Foundry-owned clone already there.
 * Never fetches when reusing. Refuses an unmarked path, and a marker naming another factory.
 */
export const ensureFactoryClone = async (factory: LoadedFactory, options: EnsureCloneOptions): Promise<EnsuredClone> => {
  const path = factoryClonePath(options.stateRoot, factory.factoryId);
  const source = cloneSource(factory, options.home);
  const entry = entryAt(path);
  if (entry !== undefined) {
    // A symlink (even a dangling one) is not Foundry's: the clone is always a real directory.
    const marker = entry.isDirectory() ? readMarker(path) : undefined;
    if (marker === undefined) {
      throw new FactoryCloneError(
        factory.factoryId,
        path,
        `${path} exists but is not a Foundry-owned clone; move it aside so Foundry can create its own`,
      );
    }
    if (marker.factory !== factory.factoryId) {
      throw new FactoryCloneError(
        factory.factoryId,
        path,
        `${path} is the clone of factory "${marker.factory}", not "${factory.factoryId}"`,
      );
    }
    return { factory: factory.factoryId, path, created: false, source: marker.source };
  }

  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A sibling, so the rename stays on one filesystem; the dot keeps it apart from factory names.
  const staging = mkdtempSync(join(parent, `.${basename(path)}.creating-`));
  try {
    const target = join(staging, "clone");
    const branch = factory.config.repository.default_branch;
    // No hooks: a clone runs `post-checkout`, and the operator's configured hooks are not Foundry's.
    await runGit(["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-hardlinks", "--branch", branch, "--", source, target], options.env ?? process.env);
    const marker: CloneMarker = {
      factory: factory.factoryId,
      source,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
    };
    writeFileSync(markerPath(target), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    renameSync(target, path);
  } catch (error) {
    throw new FactoryCloneError(
      factory.factoryId,
      path,
      `cannot clone ${source} (branch ${factory.config.repository.default_branch}) for factory "${factory.factoryId}": ${(error as Error).message}`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { factory: factory.factoryId, path, created: true, source };
};
