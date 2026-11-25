/** Read-only Git inspection outside the store lock, with a synchronous acceptance fence.
 * Hash the inputs before/after Git and again inside the transaction: an observation queued
 * behind another writer cannot authorize a changed checkout. No Git subprocess holds the lock.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { runCloneGit } from "./factory-clone.js";
import { ToolRefusal } from "./submissions.js";

const refusal = () => new ToolRefusal({ code: "invalid_code_outcome", detail: "ticket worktree changed or could not be inspected; restore it and retry" });

export const inspectCode = (path: string, branch: string) => Effect.gen(function* () {
  const git = (args: ReadonlyArray<string>) => Effect.tryPromise({
    try: () => runCloneGit(["--no-optional-locks", ...args], process.env, path), catch: refusal,
  });

  const gitDir = yield* git(["rev-parse", "--absolute-git-dir"]);
  const commonDir = resolve(path, yield* git(["rev-parse", "--git-common-dir"]));
  const tracked = (yield* git(["ls-files", "-z"])).split("\0").filter(Boolean);
  const metadata = [join(gitDir, "HEAD"), join(gitDir, "index"), join(commonDir, "packed-refs"), join(commonDir, "refs/heads", branch)];

  const fingerprint = () => {
    const hash = createHash("sha256");

    for (const file of [...metadata, ...tracked.map((file) => join(path, file))]) {
      hash.update(file).update("\0");

      try {
        const stat = lstatSync(file);
        hash.update(String(stat.mode)).update("\0");

        if (stat.isSymbolicLink()) {hash.update(readlinkSync(file));}
        else if (stat.isFile()) {hash.update(readFileSync(file));}
        // Submodule working trees need their own recursive inspection; fail closed for now.
        else {throw new Error("unsupported tracked entry");}
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {hash.update("missing");}
        else {throw cause;}
      }

      hash.update("\0");
    }

    return hash.digest("hex");
  };

  const before = yield* Effect.try({ try: fingerprint, catch: refusal });
  const head = yield* git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const actualBranch = yield* git(["symbolic-ref", "HEAD"]);
  const dirty = (yield* git(["status", "--porcelain=v1", "--untracked-files=no"])) !== "";
  const after = yield* Effect.try({ try: fingerprint, catch: refusal });

  if (before !== after) {return yield* refusal();}

  return { head, branch: actualBranch, dirty, validate: () => Effect.try({
    try: () => { if (fingerprint() !== after) {throw new Error("stale observation");} }, catch: refusal,
  }) };
});
