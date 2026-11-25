import { expect, test } from "vitest";
import { packageName } from "@foundry/cli";

test("@foundry/cli resolves through its package entry point", () => {
  expect(packageName).toBe("@foundry/cli");
});
