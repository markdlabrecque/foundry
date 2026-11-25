/**
 * The faux provider's script language. Each `@@ <tool> <json>` line in the
 * latest user message is one tool call, made in order, one per model turn.
 * After the last one (or with no script lines) the model answers `done`.
 */

import { Schema } from "effect";

/** A tool call's arguments: a JSON object, as Pi's tool calls carry them. */
export const FauxArguments = Schema.Record(Schema.String, Schema.Json);

export type FauxArguments = typeof FauxArguments.Type;

export interface FauxToolStep {
  readonly tool: string;
  readonly arguments: FauxArguments;
}

/** A content block of a Pi message; only text blocks are read. */
export interface FauxContentBlock {
  readonly type: string;
  readonly text?: string;
}

/** The part of a Pi transcript message the faux model reads. */
export interface FauxMessage {
  readonly role: string;
  readonly content?: string | ReadonlyArray<FauxContentBlock>;
}

export type FauxReply =
  | { readonly kind: "tool"; readonly step: FauxToolStep }
  | { readonly kind: "text"; readonly text: string };

export const FAUX_FINAL_TEXT = "done";

const SCRIPT_LINE = /^@@\s+(\S+)(?:\s+(.*))?$/;

const isArguments = Schema.is(FauxArguments);

const isText = Schema.is(Schema.String);

const parseArguments = (tool: string, json: string): FauxArguments => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`faux script: arguments for ${tool} are not valid JSON: ${json}`);
  }

  if (!isArguments(parsed)) {throw new Error(`faux script: arguments for ${tool} must be a JSON object: ${json}`);}

  return parsed;
};

export function parseFauxScript(text: string): Array<FauxToolStep> {
  const steps: Array<FauxToolStep> = [];

  for (const raw of text.split(/\r?\n/)) {
    const [, tool, rawArguments] = SCRIPT_LINE.exec(raw.trim()) ?? [];

    if (tool === undefined) {continue;}

    const json = rawArguments?.trim() ?? "";
    steps.push({ tool, arguments: json === "" ? {} : parseArguments(tool, json) });
  }

  return steps;
}

function textOf(content: FauxMessage["content"]): string {
  if (content === undefined) {return "";}

  if (isText(content)) {return content;}

  return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

/**
 * The next reply for a transcript: the script step after the ones already
 * answered since the latest user message, or the final text.
 */
export function nextFauxReply(messages: ReadonlyArray<FauxMessage>): FauxReply {
  let lastUser = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }

  if (lastUser < 0) {return { kind: "text", text: FAUX_FINAL_TEXT };}

  const steps = parseFauxScript(textOf(messages[lastUser]?.content));
  const answered = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  const step = steps[answered];

  return step ? { kind: "tool", step } : { kind: "text", text: FAUX_FINAL_TEXT };
}
