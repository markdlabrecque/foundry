// Unit tier: slot affinity is a pure allocation policy, without a store or worker host.
import { expect, test } from "vitest";
import { eligibleAssignmentSlots } from "../src/assignment-slots.js";

const free = { slot_id: "worker/1", condition: "normal", busy: 0 };
const previous = { slot_id: "worker/2", condition: "normal", busy: 0 };

test.each([
  { name: "first visit uses free slots in allocation order", slots: [free, previous], prior: null, expected: ["worker/1", "worker/2"] },
  { name: "return prefers its previous free slot", slots: [free, previous], prior: "worker/2", expected: ["worker/2"] },
  { name: "busy previous slot queues despite other free capacity", slots: [free, { ...previous, busy: 1 }], prior: "worker/2", expected: [] },
  { name: "frozen previous slot queues rather than falling back", slots: [free, { ...previous, condition: "frozen" }], prior: "worker/2", expected: [] },
  { name: "gone previous slot falls back", slots: [free], prior: "worker/2", expected: ["worker/1"] },
  { name: "parked previous slot falls back", slots: [free, { ...previous, condition: "parked" }], prior: "worker/2", expected: ["worker/1"] },
  { name: "gone previous slot with no capacity queues", slots: [{ ...free, busy: 1 }], prior: "worker/2", expected: [] },
  { name: "parked previous slot with no capacity queues", slots: [{ ...free, busy: 1 }, { ...previous, condition: "parked" }], prior: "worker/2", expected: [] },
])("$name", ({ slots, prior, expected }) => {
  expect(eligibleAssignmentSlots(slots, prior).map((slot) => slot.slot_id)).toEqual(expected);
});
