import { expect, test } from "vitest";
import { packageName } from "@foundry/protocol";

test("@foundry/protocol resolves through its package entry point", () => {
  expect(packageName).toBe("@foundry/protocol");
});
