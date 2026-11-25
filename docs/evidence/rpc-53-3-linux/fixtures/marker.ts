// Shared by the FOU-108 fixture extensions. Writes what this Pi process loaded, and Pi's own view
// of its tool registry at session start, to $PROBE_MARKER_DIR. Does nothing outside a probe launch.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const write = (fixture: string, phase: string, data: unknown): void => {
  const dir = process.env.PROBE_MARKER_DIR;
  const slot = process.env.FOUNDRY_SLOT;
  if (!dir || !slot) return;
  writeFileSync(join(dir, `${slot.replace("/", "_")}.${fixture}.${phase}.json`), JSON.stringify(data, null, 2));
};

/** Registers `names` as no-op tools and records the load and the session-start registry. */
export const fixture = (pi: ExtensionAPI, fixtureName: string, names: ReadonlyArray<string>): void => {
  for (const name of names) {
    pi.registerTool({
      name,
      label: name,
      description: `FOU-108 fixture tool ${name}`,
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return { content: [{ type: "text", text: `${fixtureName}:${name}` }], details: {} };
      },
    });
  }
  write(fixtureName, "loaded", { argv: process.argv, registers: names, launchId: process.env.FOUNDRY_LAUNCH_ID });
  pi.on("session_start", () => {
    write(fixtureName, "session", {
      all: pi.getAllTools().map((t) => ({ name: t.name, source: t.sourceInfo.path })),
      active: pi.getActiveTools(),
    });
  });
};
