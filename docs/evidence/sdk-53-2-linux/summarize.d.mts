export interface EvidenceSummary {
  outcome: "supported" | "blocked-on-tested-approaches" | "inconclusive";
  phase: string;
  reason: string;
  observations: Record<string, { status: "verified" | "unverified"; reason?: string }>;
}
export function summarize(record: unknown): EvidenceSummary;
