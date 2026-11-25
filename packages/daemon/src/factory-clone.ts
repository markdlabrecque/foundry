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
 * A clone that cannot be created or reused refuses that factory's start alone (PRD §11.6): the
 * daemon records one `factory.start_refused` row and the other factories start.
 *
 * Git runs with its output captured, never inherited, so the daemon's stderr stays its log.
 * Callers must hold the state-root claim.
 */
import { execFile } from "node:child_process";
import { codeOf, messageOf } from "@foundry/protocol/errors";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { isUrlSource, resolveConfiguredPath } from "./config/index.js";
import type { LoadedFactory } from "./factory-loads.js";
import { pathSegment } from "./tickets.js";
// Types only: loading `./store.js` at runtime pulls in `node:sqlite` (see quiet-store.ts).
import type { Store, StoreError } from "./store.js";

export const CLONES_DIR_NAME = "clones";

/** The ownership marker, inside the clone's `.git` directory where no worker or checkout sees it. */
export const CLONE_MARKER_FILE_NAME = "foundry-clone.json";

/** Infix of a clone's staging directory: `clones/.<factory>.creating-XXXXXX`. */
const STAGING_INFIX = ".creating-";

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

/**
 * Why a factory's clone refused its start: `clone_refused` when something Foundry does not own is
 * at the clone path (left untouched), `clone_failed` when creating the clone failed.
 */
export type CloneRefusalReason = "clone_refused" | "clone_failed";

/** The clone could not be created or reused; refuses that factory's start. */
export class FactoryCloneError extends Error {
  override readonly name = "FactoryCloneError";
  constructor(
    readonly factory: string,
    readonly clonePath: string,
    readonly reason: CloneRefusalReason,
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
  /** The source the clone was made from, as its marker records. */
  readonly source: string;
  /** The source the configuration names now; differs from `source` if it changed since. */
  readonly configuredSource: string;
}

/** The configured source as Git should see it: a URL unchanged, a local path made absolute. */
export const cloneSource = (factory: Pick<LoadedFactory, "config" | "yamlFile">, home?: string): string => {
  const source = factory.config.repository.source;

  return isUrlSource(source) ? source : resolveConfiguredPath(source, dirname(factory.yamlFile), home);
};

/** Variables that point Git at another repository, work tree or index; never inherited. */
const REPOSITORY_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
] as const;

/**
 * The environment Foundry runs Git with: no inherited repository variables, never a terminal
 * prompt, and SSH in batch mode unless the operator chose an SSH command (the daemon has no terminal).
 */
export const cloneGitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };

  for (const name of REPOSITORY_ENV) {delete out[name];}

  if (out["GIT_SSH_COMMAND"] === undefined && out["GIT_SSH"] === undefined) {out["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes";}

  return out;
};

/** The clone path's own entry, not following a symlink; `undefined` when nothing is there. */
const entryAt = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") {return undefined;}

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
    execFile("git", args, { env: cloneGitEnv(env), maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {return resolve();}

      const detail = stderr.trim().split("\n").filter((line) => line !== "").pop();
      reject(new Error(detail ?? error.message));
    });
  });

/**
 * Removes staging directories an earlier daemon left when it died mid-clone. Only safe under the
 * state-root claim, when no clone is being created. Returns the paths removed.
 */
export const clearCloneStaging = (stateRoot: string): ReadonlyArray<string> => {
  const clones = join(stateRoot, CLONES_DIR_NAME);
  let names: Array<string>;

  try {
    names = readdirSync(clones);
  } catch (error) {
    if (codeOf(error) === "ENOENT") {return [];}

    throw error;
  }

  // Factory directories are path segments that never start with "." plus this infix.
  const leftovers = names.filter((name) => name.startsWith(".") && name.includes(STAGING_INFIX)).map((name) => join(clones, name));

  for (const leftover of leftovers) {rmSync(leftover, { recursive: true, force: true });}

  return leftovers;
};

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
 * Never runs Git when reusing. Refuses an unmarked path, and a marker naming another factory.
 */
export const ensureFactoryClone = async (factory: LoadedFactory, options: EnsureCloneOptions): Promise<EnsuredClone> => {
  const path = factoryClonePath(options.stateRoot, factory.factoryId);
  const configuredSource = cloneSource(factory, options.home);
  const entry = entryAt(path);

  if (entry !== undefined) {
    // A symlink (even a dangling one) is not Foundry's: the clone is always a real directory.
    const marker = entry.isDirectory() ? readMarker(path) : undefined;

    if (marker === undefined) {
      throw new FactoryCloneError(
        factory.factoryId,
        path,
        "clone_refused",
        `${path} exists but is not a Foundry-owned clone; move it aside so Foundry can create its own`,
      );
    }

    if (marker.factory !== factory.factoryId) {
      throw new FactoryCloneError(
        factory.factoryId,
        path,
        "clone_refused",
        `${path} is the clone of factory "${marker.factory}", not "${factory.factoryId}"`,
      );
    }

    return { factory: factory.factoryId, path, created: false, source: marker.source, configuredSource };
  }

  const parent = dirname(path);
  const branch = factory.config.repository.default_branch;
  let staging: string | undefined;

  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    // A sibling, so the rename stays on one filesystem; the dot keeps it apart from factory names.
    staging = mkdtempSync(join(parent, `.${basename(path)}${STAGING_INFIX}`));
    const target = join(staging, "clone");
    // No hooks: a clone runs `post-checkout`, and the operator's configured hooks are not Foundry's.
    await runGit(
      ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-hardlinks", "--branch", branch, "--", configuredSource, target],
      options.env ?? process.env,
    );

    const marker: CloneMarker = {
      factory: factory.factoryId,
      source: configuredSource,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
    };

    writeFileSync(markerPath(target), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    renameSync(target, path);
  } catch (error) {
    throw new FactoryCloneError(
      factory.factoryId,
      path,
      "clone_failed",
      `cannot clone ${configuredSource} (branch ${branch}) for factory "${factory.factoryId}": ${messageOf(error)}`,
    );
  } finally {
    if (staging !== undefined) {rmSync(staging, { recursive: true, force: true });}
  }

  return { factory: factory.factoryId, path, created: true, source: configuredSource, configuredSource };
};

/** A factory whose start its clone refused. */
export interface CloneRefusal {
  readonly factoryId: string;
  readonly reason: CloneRefusalReason;
  readonly clonePath: string;
  readonly message: string;
}

/** The refusal an `ensureFactoryClone` failure means; any unexpected error is `clone_failed`. */
export const cloneRefusalOf = (stateRoot: string, factoryId: string, cause: unknown): CloneRefusal =>
  cause instanceof FactoryCloneError
    ? { factoryId, reason: cause.reason, clonePath: cause.clonePath, message: cause.message }
    : {
        factoryId,
        reason: "clone_failed",
        clonePath: factoryClonePath(stateRoot, factoryId),
        message: `cannot prepare the clone of factory "${factoryId}": ${messageOf(cause)}`,
      };

/**
 * Records one `factory.start_refused` row per clone refusal, all in one change, naming the
 * configuration load the start ran under. With nothing refused, nothing is written.
 */
export const recordCloneRefusals = (
  store: Store,
  refusals: ReadonlyArray<CloneRefusal & { readonly loadId?: number }>,
): Effect.Effect<void, StoreError> =>
  refusals.length === 0
    ? Effect.void
    : store.change(({ recordHistory }) =>
        Effect.forEach(
          refusals,
          (r) =>
            recordHistory({
              factoryId: r.factoryId,
              kind: "factory.start_refused",
              subject: r.factoryId,
              detail: {
                reason: r.reason,
                configLoad: r.loadId === undefined ? null : String(r.loadId),
                clonePath: r.clonePath,
                message: r.message,
              },
            }),
          { discard: true },
        ),
      );
