// Script adapter only: real Pi tools do the work; Foundry owns assignment, messages and routing.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { git } from "@foundry/testkit";

interface ScriptedOutcome {
  readonly assignmentId: string;
  readonly outcome: "done";
  readonly reason: string;
  readonly evidence: Array<string>;
  gitCommit?: string;
}

export default function ticketLineWorker(pi: ExtensionAPI): void {
  // Observe actual Pi results and incoming channel text, never invoke a handler directly.
  const journal = process.env["FOUNDRY_TEST_DISCOVERY_RESULT"];
  const record = (value: (ToolResultEvent & { slot: string | undefined }) | { received: string; slot: string | undefined }) => { if (journal) {appendFileSync(journal, `${JSON.stringify(value)}\n`);} };

  pi.on("tool_result", (event) => record({ slot: process.env["FOUNDRY_SLOT"], ...event }));
  pi.on("context", (event) => ({ messages: event.messages.map((message) => {
    if (message.role !== "user" && message.role !== "custom") {return message;}

    const text = Schema.is(Schema.String)(message.content) ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join("");

    if (text.includes("CHANNEL_HANDOFF:")) {record({ received: text, slot: process.env["FOUNDRY_SLOT"] });}

    const assignmentId = /^Assignment: (.+)$/m.exec(text)?.[1];
    const stage = /^Stage: (.+)$/m.exec(text)?.[1];
    const worktree = /^Worktree: (.+)$/m.exec(text)?.[1];
    const evidence = /^Evidence: (.+)$/m.exec(text)?.[1];
    const spec = /^Specification: (.+)$/m.exec(text)?.[1];

    if (!assignmentId || !stage || !worktree || !evidence || !spec) {return message;}

    const steps: Array<string> = [];
    const artifact = join(worktree, "ticket-result.txt");

    if (stage === "implement") {
      const body = readFileSync(spec, "utf8");
      steps.push(`@@ write ${JSON.stringify({ path: artifact, content: body })}`, `@@ bash ${JSON.stringify({ command: `git -C ${JSON.stringify(worktree)} -c core.hooksPath=/dev/null add ticket-result.txt && git -C ${JSON.stringify(worktree)} -c core.hooksPath=/dev/null commit --no-gpg-sign -m 'Disposable ticket implementation'` })}`, `@@ agent_message ${JSON.stringify({ recipient: "eng.review", body: "CHANNEL_HANDOFF: ticket-result.txt is ready for independent review", delivery: "after_turn" })}`);
    } else {
      steps.push(`@@ read ${JSON.stringify({ path: stage === "specify" ? spec : artifact })}`);
    }

    const outcome: ScriptedOutcome = {
      assignmentId, outcome: "done", reason: `Disposable ${stage} complete`, evidence: [join(evidence, `${stage}.txt`)],
    };

    if (stage !== "specify") {outcome.gitCommit = git(worktree, ["rev-parse", "HEAD"]);}

    steps.push(`@@ write ${JSON.stringify({ path: join(evidence, `${stage}.txt`), content: `Completed ${stage} in ${process.env["FOUNDRY_SLOT"] ?? "worker"}` })}`, `@@ task_transition ${JSON.stringify(outcome)}`);

    return { role: "user" as const, timestamp: message.timestamp, content: [{ type: "text" as const, text: `${text}\n${steps.join("\n")}` }] };
  }) }));
}
