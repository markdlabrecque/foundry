/** Operator decision reads and worker-request answers through the daemon API. */
import { APPROVALS_PATH, approvalPath, isApprovalDecisionResult, isApprovalListResult, isApprovalShowResult } from "@foundry/protocol/approvals";
import type { ApprovalShowResult } from "@foundry/protocol/approvals";
import { fetchAndRender } from "./read-output.js";
import type { ReadOptions } from "./read-output.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import { approvalAnswerPath, isApprovalAnswerResult } from "@foundry/protocol/approvals";
import { messageOf } from "@foundry/protocol/errors";
import { selectStateRoot } from "@foundry/protocol/state-root";
import { DaemonUnreachableError, postToDaemon } from "./management-client.js";
import type { StatusOutcome } from "./status.js";

const renderShow = ({ approval: a, commands }: ApprovalShowResult): string => [
  `approval    ${a.id}`, `kind        ${a.kind}`, `factory     ${a.factoryId}`,
  `ticket      ${a.ticket}`, `stage       ${a.stage}`, `assignment  ${a.assignmentId}`,
  `state       ${a.state}`, `decision    ${a.decision ?? "-"}`, `outcome     ${a.outcome ?? "-"}`,  `reason      ${a.reason}`,
  `raised at   ${a.raisedAt}`, `commit      ${a.commit ?? "-"}`,
  "evidence", ...a.evidence.map((path) => `  ${path}`),
  ...(commands.length === 0 ? [] : ["commands", ...commands.map((command) => `  ${command}`)]),
  "",
].join("\n");

export const runApprovalAnswer = async (options: ReadOptions & { readonly id: string; readonly body: string }): Promise<StatusOutcome> => {
  if (!/^[1-9][0-9]{0,15}$/.test(options.id) || !Number.isSafeInteger(Number(options.id)) || options.body === "" || options.home === "") {
    return { exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: answer needs a positive safe integer ID, non-empty text and a valid home\n" };
  }

  try {
    const reply = await postToDaemon(selectStateRoot(options), approvalAnswerPath(Number(options.id)), { body: options.body });

    if (options.json) {return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout: `${reply.body.trimEnd()}\n`, stderr: "" };}

    if (!reply.envelope.ok) {return { exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${reply.envelope.error.message}\n` };}

    if (!isApprovalAnswerResult(reply.envelope.result)) {return { exitCode: EXIT_REFUSED, stdout: "", stderr: "foundry: unexpected approval answer response\n" };}

    const result = reply.envelope.result;

    return { exitCode: EXIT_OK, stdout: `approval ${result.approvalId} answered by message ${result.messageId} to ${result.slotId}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: error instanceof DaemonUnreachableError ? EXIT_UNREACHABLE : EXIT_REFUSED,
      stdout: "", stderr: `foundry: ${messageOf(error)}\n` };
  }
};

export const runApprovalList = (options: ReadOptions): Promise<StatusOutcome> =>
  fetchAndRender(options, APPROVALS_PATH, isApprovalListResult, ({ approvals }) =>
    approvals.length === 0 ? "no open approvals\n" :
      `${approvals.map((a) => `${a.id}  ${a.kind}  ${a.factoryId}  ticket ${a.ticket}  ${a.stage}  ${a.reason}`).join("\n")}\n`);

export const runApprovalShow = (options: ReadOptions & { readonly id: string }): Promise<StatusOutcome> => {
  if (!/^[1-9][0-9]{0,15}$/.test(options.id) || !Number.isSafeInteger(Number(options.id))) {
    return Promise.resolve({ exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: approval ID must be a positive safe integer\n" });
  }

  return fetchAndRender(options, approvalPath(Number(options.id)), isApprovalShowResult, renderShow);
};

export const runApprovalDecision = (options: ReadOptions & {
  readonly id: string;
  readonly decision: "approve" | "reject";
  readonly reason?: string;
}): Promise<StatusOutcome> => {
  if (!/^[1-9][0-9]{0,15}$/.test(options.id) || !Number.isSafeInteger(Number(options.id)) ||
    (options.decision === "reject" && (options.reason === undefined || options.reason.trim() === ""))) {
    return Promise.resolve({ exitCode: EXIT_USAGE, stdout: "", stderr: "foundry: a positive approval ID and a reason for reject are required\n" });
  }

  const body = options.reason === undefined ? {} : { reason: options.reason };

  return fetchAndRender(options, `${approvalPath(Number(options.id))}/${options.decision}`, isApprovalDecisionResult,
    (result) => `approval ${result.approvalId} ${result.decision} at ${result.commit}${result.integrationRequested ? "; integration requested" : ""}\n`,
    (stateRoot, path) => postToDaemon(stateRoot, path, body));
};
