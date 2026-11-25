import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { PI_ALL_BUILTIN_TOOLS, PI_BUILTIN_TOOLS, isReservedToolName } from "@foundry/protocol";

// Unit tier: pins the reserved built-in list to the installed Pi, so a Pi upgrade
// that adds a built-in fails here instead of letting an extension shadow it.
// `allToolNames` is not on Pi's public exports, so it is loaded by file path.
test("every tool the pinned Pi builds in is reserved", async () => {
  const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

  const tools = (await import(pathToFileURL(join(dist, "core/tools/index.js")).href)) as {
    allToolNames: Set<string>;
  };

  expect([...tools.allToolNames].sort()).toEqual([...PI_ALL_BUILTIN_TOOLS].sort());
  expect(PI_ALL_BUILTIN_TOOLS).toEqual(expect.arrayContaining([...PI_BUILTIN_TOOLS]));

  for (const name of tools.allToolNames) {expect(isReservedToolName(name)).toBe(true);}
});
