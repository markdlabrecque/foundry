/**
 * `foundry status` (PRD §11.2): one `GET /api/v1/status` over the management socket. Parsing the
 * command line belongs to `main.ts`; this module takes parsed options and returns what to print
 * and the exit code (PRD §11.5).
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import { isStatusResult, STATUS_PATH } from "@foundry/protocol/management-api";
import type { StatusResult } from "@foundry/protocol/management-api";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREACHABLE = 3;

export interface StatusOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What `foundry status` prints and the exit code it ends with. */
export interface StatusOutcome {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
}

const renderStatus = ({ instance }: StatusResult): string =>
  [`state root  ${instance.stateRoot}`, `daemon pid  ${instance.daemonPid}`, `started at  ${instance.startedAt}`].join(
    "\n",
  ) + "\n";

const refused = (message: string): StatusOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

/** Asks the daemon serving the selected state root for its status. */
export const runStatus = async (options: StatusOptions): Promise<StatusOutcome> => {
  if (options.home === "") {
    return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: --home needs a directory\n" };
  }

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await getFromDaemon(stateRoot, STATUS_PATH);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }

    return refused(messageOf(error));
  }

  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;

    return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }

  if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

  if (!isStatusResult(reply.envelope.result)) {return refused("the daemon answered status with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: renderStatus(reply.envelope.result), stderr: "" };
};
