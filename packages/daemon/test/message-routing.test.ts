// Unit tier: station/assignment preference needs no runtime, channel or database.
import { expect, test } from "vitest";
import { selectMessageSlot } from "@foundry/daemon";
import type { RoutingSlot } from "@foundry/daemon";

const slot = (slotId: string, ordinal: number, condition = "normal", station = "eng.builder", factoryId = "alpha"): RoutingSlot =>
  ({ factoryId, slotId, ordinal, station, condition });

const slots = [slot("builder/10", 10), slot("builder/2", 2), slot("builder/1", 1),
  slot("builder/3", 3, "frozen"), slot("builder/4", 4, "parked"),
  slot("deployer/1", 1, "normal", "ops.deployer"), slot("builder/0", 1, "normal", "eng.builder", "beta")];

test.each([
  { name: "lowest numeric ordinal, not input or lexical order", assigned: null, expected: "builder/1" },
  { name: "eligible ticket assignment wins", assigned: "builder/10", expected: "builder/10" },
  { name: "foreign station assignment ignored", assigned: "deployer/1", expected: "builder/1" },
  { name: "foreign factory assignment ignored", assigned: "builder/0", expected: "builder/1" },
  { name: "frozen assignment ignored", assigned: "builder/3", expected: "builder/1" },
  { name: "parked assignment ignored", assigned: "builder/4", expected: "builder/1" },
  { name: "unknown assignment ignored", assigned: "absent/1", expected: "builder/1" },
])("$name", ({ assigned, expected }) => {
  expect(selectMessageSlot("alpha", "eng.builder", slots, assigned)).toBe(expected);
  expect(selectMessageSlot("alpha", "eng.builder", slots.toReversed(), assigned)).toBe(expected);
});

test("no eligible slot leaves work unbound; unknown conditions fail closed", () => {
  expect(selectMessageSlot("alpha", "missing", slots)).toBeNull();
  expect(selectMessageSlot("alpha", "eng.builder", [slot("builder/1", 1, "frozen"), slot("builder/2", 2, "parked"), slot("builder/3", 3, "unknown")])).toBeNull();
  expect(selectMessageSlot("alpha", "eng.builder", [])).toBeNull();
});
