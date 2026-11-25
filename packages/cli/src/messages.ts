/** `foundry message send`: one API call; only the daemon opens or writes the message store. */
import { createInterface } from "node:readline/promises";
import { messageOf } from "@foundry/protocol/errors";
import { isOperatorMessageResult, isMessageDispositionResult, messagePath, MESSAGES_PATH } from "@foundry/protocol/messages-api";
import type { SendMessageRequest } from "@foundry/protocol/messages-api";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { DaemonUnreachableError, getFromDaemon, postToDaemon } from "./management-client.js";
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

interface MessageDispositionOptions {
  readonly id: string;
  readonly action: "resend" | "drop";
  readonly yes: boolean;
  readonly json: boolean;
  readonly home: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly terminal?: boolean;
  readonly confirm?: () => Promise<boolean>;
  readonly notice?: (text: string) => void;
}

const confirmDrop = async (): Promise<boolean> => {
  const input = createInterface({ input: process.stdin, output: process.stderr });

  try {return (await input.question("Drop this message? [y/N] ")).trim().toLowerCase() === "y";}
  finally {input.close();}
};

export const runMessageDisposition = async (options: MessageDispositionOptions): Promise<StatusOutcome> => {
  if (options.home === "" || options.id === "") {return usage("provide a message ID and valid --home");}

  try {
    const root = selectStateRoot(options);
    const path = messagePath(options.id);

    if (options.action === "drop") {
      const inspection = await getFromDaemon(root, path);

      if (!inspection.envelope.ok) {return refused(inspection.envelope.error.message);}

      if (!isMessageDispositionResult(inspection.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

      const message = inspection.envelope.result;
      const losses = `Drop message ${message.id} (${message.kind}). Request: ${message.requestId ?? "none"}; delegation: ${message.delegationId ?? "none"}. A correlated request/delegation will fail.\n`;
      (options.notice ?? ((text: string) => { process.stderr.write(text); }))(losses);

      if (!options.yes) {
        if (!(options.terminal ?? process.stdin.isTTY === true)) {return usage("message drop requires a terminal or --yes; nothing dropped");}

        if (!await (options.confirm ?? confirmDrop)()) {return usage("drop not confirmed; nothing dropped");}
      }
    }

    const reply = await postToDaemon(root, `${path}/${options.action}`, { confirmed: options.action === "drop" });

    if (options.json) {return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout: `${reply.body.trimEnd()}\n`, stderr: "" };}

    if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

    if (!isMessageDispositionResult(reply.envelope.result)) {return refused("the daemon answered with an unexpected shape");}

    return { exitCode: EXIT_OK, stdout: options.action === "resend" ? `message ${options.id} queued for resend (possible duplicate accepted)\n` : `message ${options.id} dropped\n`, stderr: "" };
  } catch (cause) {
    return { exitCode: cause instanceof DaemonUnreachableError ? EXIT_UNREACHABLE : EXIT_REFUSED, stdout: "", stderr: `foundry: ${messageOf(cause)}\n` };
  }
};

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
