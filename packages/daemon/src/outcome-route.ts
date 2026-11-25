/** Pure configured route selection. Missing rejection routes belong to the blocked path. */
export const outcomeRoute = (
  stages: ReadonlyArray<{ readonly id: string; readonly on_rejection?: string }>,
  stageId: string,
  outcome: "done" | "rejected",
): string | undefined => {
  const index = stages.findIndex((stage) => stage.id === stageId);

  if (index < 0) {return undefined;}

  if (outcome === "done") {return stages[index + 1]?.id;}

  const target = stages[index]?.on_rejection;

  return stages.slice(0, index).find((stage) => stage.id === target)?.id;
};
