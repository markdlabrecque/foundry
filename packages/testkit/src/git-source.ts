/**
 * A disposable local Git repository to use as a factory's `repository.source` in tests, so no
 * test ever contacts a real remote. Git runs isolated from the operator's configuration (no global
 * or system config, so no hooks fire) with a fixed fixture identity.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Environment for Git in tests: no operator config, hooks or prompts; a fixed identity. */
export const isolatedGitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Foundry Fixture",
  GIT_AUTHOR_EMAIL: "fixture@foundry.invalid",
  GIT_COMMITTER_NAME: "Foundry Fixture",
  GIT_COMMITTER_EMAIL: "fixture@foundry.invalid",
});

/** Runs Git in `cwd` with the isolated environment and returns its trimmed stdout. */
export const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, env: isolatedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Creates a repository at `dir` with one commit on `branch`; returns that commit's ID. */
export const makeGitSource = (dir: string, branch = "main"): string => {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch", branch]);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "--quiet", "--no-verify", "-m", "fixture"]);
  return git(dir, ["rev-parse", "HEAD"]);
};
