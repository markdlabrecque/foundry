/**
 * `foundry factory path <name>` (PRD §9.1, §11.1): one `GET` over the management socket, printing
 * the factory's dedicated clone path. The CLI never opens the database (ADR 0001).
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { factoryPathPath, isFactoryPathResult } from "@foundry/protocol/factory-path";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE, type StatusOutcome } from "./status.js";

export interface FactoryPathOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
}

export type FactoryOutcome = StatusOutcome;

const refused = (message: string): FactoryOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

/** `foundry factory path <name>`: the clone path, one line, for use as a Git remote. */
export const runFactoryPath = async (options: FactoryPathOptions): Promise<FactoryOutcome> => {
  if (options.home === "") return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };
  if (options.name === "") return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: factory name must not be empty\n" };
  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;
  try {
    reply = await getFromDaemon(stateRoot, factoryPathPath(options.name));
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }
    return refused((error as Error).message);
  }
  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;
    return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }
  if (!reply.envelope.ok) return refused(reply.envelope.error.message);
  if (!isFactoryPathResult(reply.envelope.result)) return refused("the daemon answered with an unexpected shape");
  return { exitCode: EXIT_OK, stdout: `${reply.envelope.result.path}\n`, stderr: "" };
};
