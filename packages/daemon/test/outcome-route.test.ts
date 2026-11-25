// Unit tier: configured transition table needs no store or worker.
import { expect, test } from "vitest";
import { outcomeRoute } from "../src/outcome-route.js";

const stages = [
  { id: "plan" },
  { id: "build", on_rejection: "plan" },
  { id: "review", on_rejection: "build" },
  { id: "release", on_rejection: "plan" },
];

test.each([
  ["plan", "done", "build"],
  ["build", "done", "review"],
  ["review", "done", "release"],
  ["release", "done", undefined],
  ["build", "rejected", "plan"],
  ["review", "rejected", "build"],
  ["release", "rejected", "plan"],
  ["plan", "rejected", undefined],
  ["missing", "rejected", undefined],
] as const)("%s / %s routes to %s", (stage, outcome, target) => {
  expect(outcomeRoute(stages, stage, outcome)).toBe(target);
});

test.each(["review", "release", "missing"])("invalid earlier-stage route %s fails closed", (target) => {
  expect(outcomeRoute([{ id: "review", on_rejection: target }, { id: "release" }], "review", "rejected"))
    .toBeUndefined();
});
