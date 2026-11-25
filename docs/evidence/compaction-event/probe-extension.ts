// FOU-28 compaction probe extension for bare Pi 1.6.0.
//
// Registers a credential-free scripted model (pi-ai's built-in faux core) with a
// tiny context window, a `pad` tool that returns a large result, and a logger that
// appends every lifecycle and compaction event to the JSONL file named by
// PROBE_LOG. It is a disposable fixture, not Foundry code.
//
// Scripting rule for the model. In the submitted prompt (read from the `input`
// event, so the plan survives a compaction that summarizes the prompt away):
//   ROUNDS <n>  -> call `pad` n times, then reply with text "done".
//   SIZE <n>    -> characters each `pad` result returns (default 8000).
// A request whose system prompt is Pi's summarization prompt gets a fixed summary.

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const LOG = process.env.PROBE_LOG;
let seq = 0;

function log(record: Record<string, unknown>): void {
	if (!LOG) {return;}

	appendFileSync(LOG, `${JSON.stringify({ seq: seq++, ...record })}\n`);
}

function textOf(message: any): string {
	const c = message?.content;

	if (typeof c === "string") {return c;}

	if (Array.isArray(c)) {return c.map((b: any) => (b?.type === "text" ? b.text : "")).join("");}

	return "";
}

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "probe",
		api: "probe-faux",
		models: [{ id: "tiny", name: "Probe tiny", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1024 }],
	});

	let padCalls = 0;
	let plan = { rounds: 0, size: 8000, done: 0 };
	pi.on("input", async (event) => {
		plan = {
			rounds: Number(/ROUNDS (\d+)/.exec(event.text)?.[1] ?? 0),
			size: Number(/SIZE (\d+)/.exec(event.text)?.[1] ?? 8000),
			done: 0,
		};
		log({ kind: "event", type: "input", rounds: plan.rounds, size: plan.size, promptChars: event.text.length });
	});

	const respond = (context: any) => {
		const messages: Array<any> = context.messages;
		const chars = messages.reduce((n, m) => n + textOf(m).length, 0);

		if (getCurrentSystemPrompt(messages).includes("context summarization assistant")) {
			log({ kind: "model_call", purpose: "summary", requestChars: chars });

			return fauxAssistantMessage(fauxText("## Goal\nProbe compaction.\n\n## Progress\n- [x] probe summary"));
		}

		if (plan.done < plan.rounds) {
			plan.done++;
			padCalls++;
			log({ kind: "model_call", purpose: "tool_call", round: plan.done, requestChars: chars });

			return fauxAssistantMessage(fauxToolCall("pad", { size: plan.size }, { id: `pad-${padCalls}` }), { stopReason: "toolUse" });
		}

		log({ kind: "model_call", purpose: "final_text", requestChars: chars });

		return fauxAssistantMessage(fauxText("done"));
	};

	// The faux core pops one queued step per request; queue plenty of the same factory.
	faux.setResponses(Array.from({ length: 500 }, () => respond));
	pi.registerProvider(faux.provider);

	pi.registerTool({
		name: "pad",
		label: "Pad",
		description: "Return a large filler result.",
		parameters: Type.Object({ size: Type.Number() }),
		async execute(toolCallId, params) {
			return { content: [{ type: "text", text: "x".repeat(params.size) }], details: { toolCallId } };
		},
	});

	const plain = [
		"agent_start",
		"agent_end",
		"agent_settled",
		"before_agent_start",
		"tool_execution_start",
		"tool_execution_end",
	] as const;

	for (const type of plain) {
		pi.on(type as any, async (event: any, ctx: any) => {
			const extra: Record<string, unknown> = {};

			if (type === "tool_execution_start" || type === "tool_execution_end") {extra.toolCallId = event.toolCallId;}

			if (type === "agent_settled") {extra.aborted = event.aborted;}

			log({ kind: "event", type, idle: ctx.isIdle(), ...extra });
		});
	}

	pi.on("turn_start", async (event, ctx) => log({ kind: "event", type: "turn_start", turnIndex: event.turnIndex, idle: ctx.isIdle() }));
	pi.on("turn_end", async (event, ctx) =>
		log({
			kind: "event",
			type: "turn_end",
			turnIndex: event.turnIndex,
			stopReason: (event.message as any)?.stopReason,
			toolResults: event.toolResults.length,
			idle: ctx.isIdle(),
		}),
	);
	pi.on("session_before_compact", async (event, ctx) =>
		log({
			kind: "event",
			type: "session_before_compact",
			reason: event.reason,
			willRetry: event.willRetry,
			tokensBefore: event.preparation.tokensBefore,
			isSplitTurn: event.preparation.isSplitTurn,
			idle: ctx.isIdle(),
		}),
	);
	pi.on("session_compact", async (event, ctx) => {
		// systemMessage/toolsAdded carry machine-specific paths; log only their presence.
		const { summary, systemMessage, toolsAdded, ...entry } = event.compactionEntry as any;
		entry.hasSystemMessage = systemMessage !== undefined;
		entry.toolsAddedCount = Array.isArray(toolsAdded) ? toolsAdded.length : 0;
		log({
			kind: "event",
			type: "session_compact",
			reason: event.reason,
			willRetry: event.willRetry,
			fromExtension: event.fromExtension,
			compactionEntry: { ...entry, id: "<id>", parentId: "<id>", firstKeptEntryId: "<id>", timestamp: "<ts>", summaryChars: summary?.length },
			idle: ctx.isIdle(),
		});
	});
	pi.on("session_compact_failed", async (event, ctx) => log({ kind: "event", type: "session_compact_failed", ...event, idle: ctx.isIdle() }));
}
