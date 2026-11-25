/** Durable approval reads. The originating immutable transition owns outcome, reason and evidence. */
import { Effect, Schema } from "effect";
import { ApprovalRecord, approvalCommands } from "@foundry/protocol/approvals";
import type { ApprovalListResult, ApprovalShowResult } from "@foundry/protocol/approvals";
import type { Store } from "./store.js";

interface ApprovalRow {
  readonly id: number;
  readonly factory_id: string;
  readonly ticket_number: number;
  readonly assignment_id: string;
  readonly transition_sequence: number;
  readonly kind: string;
  readonly state: string;
  readonly raised_at: number;
  readonly closed_at: number | null;
  readonly from_stage: string;
  readonly outcome: string;
  readonly reason: string;
  readonly evidence: string;
  readonly git_commit: string | null;
  readonly config_load: string | null;
}

const SELECT = `SELECT a.*, t.from_stage, t.outcome, t.reason, t.evidence, t.git_commit, t.config_load
  FROM approval a JOIN ticket_transition t ON t.sequence = a.transition_sequence`;

const decode = Schema.decodeUnknownSync(ApprovalRecord);
const decodeEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const toRecord = (row: ApprovalRow): ApprovalRecord => decode({
  id: row.id, factoryId: row.factory_id, ticket: row.ticket_number, assignmentId: row.assignment_id,
  transition: row.transition_sequence, stage: row.from_stage, kind: row.kind, state: row.state,
  outcome: row.outcome, reason: row.reason, evidence: decodeEvidence(row.evidence), commit: row.git_commit,
  configLoad: row.config_load, raisedAt: new Date(row.raised_at).toISOString(),
  closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
});

export interface ApprovalsReader {
  readonly list: () => Promise<ApprovalListResult>;
  readonly show: (id: number) => Promise<ApprovalShowResult | undefined>;
}

export const storeApprovalsReader = (store: Store): ApprovalsReader => ({
  list: () => Effect.runPromise(Effect.map(
    store.read<ApprovalRow>(`${SELECT} WHERE a.state = 'open' ORDER BY a.id`),
    (rows) => ({ approvals: rows.map(toRecord) }),
  )),
  show: (id) => Effect.runPromise(Effect.map(
    store.read<ApprovalRow>(`${SELECT} WHERE a.id = ?`, [id]),
    (rows) => {
      const row = rows[0];

      if (row === undefined) {return undefined;}

      const approval = toRecord(row);

      return { approval, commands: approvalCommands(approval) };
    },
  )),
});
