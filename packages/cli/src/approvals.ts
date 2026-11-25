/** `foundry approval list | show <id>`: decisions and the exact ticket actions that resolve them. */
import { APPROVALS_PATH, approvalPath, isApprovalListResult, isApprovalShowResult } from "@foundry/protocol/approvals";
import type { ApprovalShowResult } from "@foundry/protocol/approvals";
import { fetchAndRender } from "./read-output.js";
import type { ReadOptions } from "./read-output.js";
import { EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

const renderShow = ({ approval: a, commands }: ApprovalShowResult): string => [
  `approval    ${a.id}`, `kind        ${a.kind}`, `factory     ${a.factoryId}`,
  `ticket      ${a.ticket}`, `stage       ${a.stage}`, `assignment  ${a.assignmentId}`,
  `state       ${a.state}`, `outcome     ${a.outcome ?? "-"}`,  `reason      ${a.reason}`,
  `raised at   ${a.raisedAt}`, `commit      ${a.commit ?? "-"}`,
  "evidence", ...a.evidence.map((path) => `  ${path}`),
  ...(commands.length === 0 ? [] : ["commands", ...commands.map((command) => `  ${command}`)]),
  "",
].join("\n");

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
