/**
 * `foundry factory list` (PRD §11.1–§11.2): one `GET /api/v1/factories` over the management
 * socket. Parsing the command line belongs to `main.ts`; this module takes parsed options and
 * returns what to print and the exit code (PRD §11.5).
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { FACTORIES_PATH, isFactoryListResult } from "@foundry/protocol/factories-api";
import type { FactoryListResult } from "@foundry/protocol/factories-api";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

export interface FactoryListOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type FactoryOutcome = StatusOutcome;

const refused = (message: string): FactoryOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

const renderList = ({ factories }: FactoryListResult): string =>
  factories.length === 0
    ? "no factories loaded\n"
    : `${factories.map((f) => `${f.factoryId}  ${f.state}  load ${f.loadId}  ${f.configHash}  ${f.yamlFile}`).join("\n")}\n`;

/** `foundry factory list`: the factories the daemon loaded, with their recorded configuration loads. */
export const runFactoryList = async (options: FactoryListOptions): Promise<FactoryOutcome> => {
  if (options.home === "") {return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await getFromDaemon(stateRoot, FACTORIES_PATH);
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

  if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

  if (!isFactoryListResult(reply.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: renderList(reply.envelope.result), stderr: "" };
};
