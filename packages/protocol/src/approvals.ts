/** Operator decisions about work (PRD §8.2, §11.3), distinct from system holds. */
import { Schema } from "effect";
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

export const APPROVALS_PATH = `${MANAGEMENT_API_PREFIX}/approvals`;
export const approvalPath = (id: number): string => `${APPROVALS_PATH}/${id}`;

/** Worker requests have no originating transition or outcome: they do not move the ticket. */
export const ApprovalRecord = Schema.Struct({
  id: Schema.Number,
  factoryId: Schema.String,
  ticket: Schema.Number,
  assignmentId: Schema.String,
  transition: Schema.NullOr(Schema.Number),
  stage: Schema.String,
  kind: Schema.Literals(["blocked", "worker_request", "limit_reached"]),
  state: Schema.Literals(["open", "resolved"]),
  outcome: Schema.NullOr(Schema.Literals(["blocked", "rejected"])),
  reason: Schema.String,
  evidence: Schema.Array(Schema.String),
  commit: Schema.NullOr(Schema.String),
  configLoad: Schema.NullOr(Schema.String),
  raisedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
});

export type ApprovalRecord = typeof ApprovalRecord.Type;

export const ApprovalListResult = Schema.Struct({ approvals: Schema.Array(ApprovalRecord) });

export type ApprovalListResult = typeof ApprovalListResult.Type;

export const ApprovalShowResult = Schema.Struct({ approval: ApprovalRecord, commands: Schema.Array(Schema.String) });

export type ApprovalShowResult = typeof ApprovalShowResult.Type;

export const isApprovalListResult = Schema.is(ApprovalListResult);
export const isApprovalShowResult = Schema.is(ApprovalShowResult);

/** Include the factory even with multiple loaded factories; quote shell metacharacters safely. */
export const approvalCommands = (approval: Pick<ApprovalRecord, "factoryId" | "ticket" | "state" | "kind">): ReadonlyArray<string> => {
  if (approval.state !== "open" || approval.kind === "worker_request") {return [];}

  const factory = `'${approval.factoryId.replaceAll("'", String.raw`'\''`)}'`;

  return ["resume", "retry", "cancel"].map((verb) => `foundry ticket ${verb} ${approval.ticket} --factory ${factory}`);
};
