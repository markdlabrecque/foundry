import { expect, test } from "vitest";
import { packageName } from "@foundry/host";

test("@foundry/host resolves through its package entry point", () => {
  expect(packageName).toBe("@foundry/host");
});
