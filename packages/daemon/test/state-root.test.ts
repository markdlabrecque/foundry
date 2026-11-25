import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { selectStateRoot } from "@foundry/daemon";

test("--home wins over FOUNDRY_HOME and the default", () => {
  expect(selectStateRoot({ home: "/a", env: { FOUNDRY_HOME: "/b" }, userHome: "/u" })).toBe("/a");
});

test("FOUNDRY_HOME is used when --home is absent", () => {
  expect(selectStateRoot({ env: { FOUNDRY_HOME: "/b" }, userHome: "/u" })).toBe("/b");
});

test("the default is ~/.foundry, and empty values count as unset", () => {
  expect(selectStateRoot({ home: "", env: { FOUNDRY_HOME: "" }, userHome: "/u" })).toBe(join("/u", ".foundry"));
});

test("a relative root is made absolute", () => {
  expect(selectStateRoot({ home: "rel", env: {} })).toBe(resolve("rel"));
});
