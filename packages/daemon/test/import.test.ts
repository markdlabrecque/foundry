import { expect, test } from "vitest";
import { packageName } from "@foundry/daemon";

test("@foundry/daemon resolves through its package entry point", () => {
  expect(packageName).toBe("@foundry/daemon");
});
