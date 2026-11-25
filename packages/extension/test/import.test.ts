import { expect, test } from "vitest";
import { packageName } from "@foundry/extension";

test("@foundry/extension resolves through its package entry point", () => {
  expect(packageName).toBe("@foundry/extension");
});
