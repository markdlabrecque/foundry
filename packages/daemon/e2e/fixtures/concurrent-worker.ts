// Test-only script adapter. The real daemon still assigns work, delivers messages and interrupts Pi.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Schema } from "effect";

export default function concurrentWorker(pi: ExtensionAPI): void {
  pi.on("context", (event) => {
    let worktree: string | undefined;
    let evidence: string | undefined;
    let ticket: string | undefined;

    return { messages: event.messages.map((message) => {
      if (message.role !== "user" && message.role !== "custom") {return message;}

      const text = Schema.is(Schema.String)(message.content) ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join("");
      worktree = /^Worktree: (.+)$/m.exec(text)?.[1] ?? worktree;
      evidence = /^Evidence: (.+)$/m.exec(text)?.[1] ?? evidence;
      ticket = /Ticket (\d+)/.exec(text)?.[1] ?? ticket;

      if (!text.includes("Assignment:") || worktree === undefined || evidence === undefined || ticket === undefined) {return message;}

      return { role: "user" as const, timestamp: message.timestamp, content: [{ type: "text" as const, text: `${text}\n@@ fixture_work ${JSON.stringify({ worktree, evidence, ticket, resumed: text.includes("The worker was interrupted") })}` }] };
    }) };
  });
  pi.registerTool({
    name: "fixture_work",
    label: "Disposable work",
    description: "Write isolated evidence, then wait for the test operator's release or a real abort.",
    parameters: Type.Object({ worktree: Type.String(), evidence: Type.String(), ticket: Type.String(), resumed: Type.Boolean() }),
    async execute(_id, params, signal) {
      const phase = params.resumed ? "resumed" : "started";
      writeFileSync(join(params.worktree, `${phase}.txt`), params.ticket);
      writeFileSync(join(params.evidence, `${phase}.txt`), params.ticket);

      try {
        while (!existsSync(join(params.evidence, "release"))) {
          await setTimeout(25, undefined, { signal });
        }

        writeFileSync(join(params.evidence, "progressed.txt"), params.ticket);
      } catch (error) {
        if (!signal?.aborted) {throw error;}

        writeFileSync(join(params.evidence, "interrupted.txt"), params.ticket);
      }

      return { content: [{ type: "text", text: "fixture complete" }], details: {} };
    },
  });
}
