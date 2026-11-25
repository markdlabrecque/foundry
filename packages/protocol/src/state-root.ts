import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Inputs to state-root selection, injected so the rule is testable without touching the operator's home. */
export interface StateRootInputs {
  /** The `--home` flag, if given. */
  readonly home?: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory. */
  readonly userHome?: string;
}

/**
 * Shared by the daemon and the CLI, so both find the same instance without the CLI loading the daemon.
 *
 * Select the instance's state root (PRD §3): `--home`, else `FOUNDRY_HOME`, else `~/.foundry`.
 * Empty values count as unset. The result is an absolute path.
 */
export const selectStateRoot = (inputs: StateRootInputs): string => {
  if (inputs.home !== undefined && inputs.home !== "") return resolve(inputs.home);
  const fromEnv = inputs.env["FOUNDRY_HOME"];
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  return join(inputs.userHome ?? homedir(), ".foundry");
};
