/**
 * Freezing a slot when an instruction file is missing at priming time (PRD §5.3, §5.5).
 *
 * A prime whose composition cannot read an instruction file is not sent: the primer freezes the
 * slot with the `instruction_missing` cause and a hold naming the files. The unfreeze check here
 * composes the slot's prime again, so the slot is unfrozen only once every file reads.
 */
import { dirname } from "node:path";
import type { HoldEvidence } from "@foundry/protocol/holds";
import type { CauseCheck, SlotRef } from "./freeze.js";
import type { LoadedFactory } from "./factory-loads.js";
import { ComposePrimeResult, composePrime } from "./prime.js";
import type { PrimeRequest, PrimeSourceProblem } from "./prime.js";
import type { PlannedSlot } from "./slots.js";

/** A slot's prime inputs, without the situation; `undefined` when no effective station is known. */
export type SlotPrimeRequest = (slot: SlotRef) => Omit<PrimeRequest, "situation"> | undefined;

/** The frozen-slot hold's evidence: the unreadable files by source path, then why each failed. */
export const instructionMissingEvidence = (problems: ReadonlyArray<PrimeSourceProblem>): HoldEvidence => ({
  missing: problems.map((problem) => problem.source),
  problems: problems.map(({ source, reason, detail }) => ({ source, reason, detail })),
});

const isSourceUnavailable = ComposePrimeResult.$is("SourceUnavailable");

/** The `instruction_missing` check: composes the slot's prime again and passes only if every file reads. */
export const instructionFilesCheck =
  (primeRequest: SlotPrimeRequest, compose: (request: PrimeRequest) => Promise<ComposePrimeResult> = (r) => composePrime(r)): CauseCheck =>
  async (slot) => {
    const request = primeRequest(slot);

    if (request === undefined) {return { fixed: false, evidence: { missing: [], unknownStation: true } };}

    const composed = await compose({ ...request, situation: "fresh" });

    return isSourceUnavailable(composed) ? { fixed: false, evidence: instructionMissingEvidence(composed.problems) } : { fixed: true };
  };

/** Each planned slot's prime inputs, from its factory's YAML directory, knowledge root and effective station. */
export const plannedPrimeRequests = (
  factories: ReadonlyArray<Pick<LoadedFactory, "factoryId" | "yamlFile" | "knowledge">>,
  slots: ReadonlyArray<PlannedSlot>,
): SlotPrimeRequest => {
  const byFactory = new Map(factories.map((factory) => [factory.factoryId, factory]));

  return (slot) => {
    const planned = slots.find((s) => s.factoryId === slot.factoryId && s.slotId === slot.slotId);
    const factory = byFactory.get(slot.factoryId);

    if (planned === undefined || factory === undefined) {return undefined;}

    return {
      address: planned.station.address,
      slotId: slot.slotId,
      isolation: planned.station.isolation,
      instructions: planned.station.instructions,
      knowledgeRoot: factory.knowledge.root,
      baseDir: dirname(factory.yamlFile),
    };
  };
};
