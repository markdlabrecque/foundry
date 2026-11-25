import { expect, test } from "vitest";
import { packageName } from "@foundry/testkit";

test("@foundry/testkit resolves through its package entry point", () => {
  expect(packageName).toBe("@foundry/testkit");
});
