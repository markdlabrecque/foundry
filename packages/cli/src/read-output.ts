/** Shared management-API read boundary for operator record list/show commands. */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

export interface ReadOptions {
  readonly json: boolean;
  readonly home: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const refused = (message: string): StatusOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });
const usage = (message: string): StatusOutcome => ({ exitCode: EXIT_USAGE, stdout: "", stderr: `foundry: ${message}\n` });

/** Fetches `path` and renders its result once `is` confirms the shape the daemon answered with. */
export const fetchAndRender = async <A>(
  options: ReadOptions,
  path: string,
  is: (value: unknown) => value is A,
  render: (result: A) => string,
): Promise<StatusOutcome> => {
  if (options.home === "") {return usage("--home needs a directory");}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await getFromDaemon(stateRoot, path);
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

  const result = reply.envelope.result;

  if (!is(result)) {return refused("the daemon answered with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: render(result), stderr: "" };
};
