/** `foundry message send`: one API call; only the daemon opens or writes the message store. */
import { messageOf } from "@foundry/protocol/errors";
import { isOperatorMessageResult, MESSAGES_PATH } from "@foundry/protocol/messages-api";
import type { SendMessageRequest } from "@foundry/protocol/messages-api";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { DaemonUnreachableError, postToDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

export interface MessageSendOptions {
  readonly recipient: string;
  readonly body: string;
  readonly delivery: string | undefined;
  readonly factory: string | undefined;
  readonly json: boolean;
  readonly home: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const usage = (message: string): StatusOutcome => ({ exitCode: EXIT_USAGE, stdout: "", stderr: `foundry: ${message}\n` });
const refused = (message: string): StatusOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

export const runMessageSend = async (options: MessageSendOptions): Promise<StatusOutcome> => {

  if (options.home === "") {return usage("--home needs a directory");}

  if (options.factory === "") {return usage("--factory needs a name");}

  if (options.recipient === "") {return usage("a recipient station is required");}

  const delivery = options.delivery ?? "after_turn";

  if (delivery !== "after_turn" && delivery !== "when_idle") {return usage("--delivery must be after_turn or when_idle");}

  try {
    let request: SendMessageRequest = { recipient: options.recipient, body: options.body, delivery };

    if (options.factory !== undefined) {request = { ...request, factory: options.factory };}

    const reply = await postToDaemon(selectStateRoot(options), MESSAGES_PATH, request);

    if (options.json) {
      return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED,
        stdout: reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`, stderr: "" };
    }

    if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

    if (!isOperatorMessageResult(reply.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

    const message = reply.envelope.result;

    return { exitCode: EXIT_OK, stdout: `message ${message.id} accepted in ${message.factoryId} (#${message.sequence})\n`, stderr: "" };
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }

    return refused(messageOf(error));
  }
};
