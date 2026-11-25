/**
 * The faux provider's script language. Each `@@ <tool> <json>` line in the
 * latest user message is one tool call, made in order, one per model turn.
 * After the last one (or with no script lines) the model answers `done`.
 */

export interface FauxToolStep {
  readonly tool: string;
  readonly arguments: { readonly [key: string]: unknown };
}

/** The part of a Pi transcript message the faux model reads. */
export interface FauxMessage {
  readonly role: string;
  readonly content?: unknown;
}

export type FauxReply =
  | { readonly kind: "tool"; readonly step: FauxToolStep }
  | { readonly kind: "text"; readonly text: string };

export const FAUX_FINAL_TEXT = "done";

const SCRIPT_LINE = /^@@\s+(\S+)(?:\s+(.*))?$/;

export function parseFauxScript(text: string): Array<FauxToolStep> {
  const steps: Array<FauxToolStep> = [];

  for (const raw of text.split(/\r?\n/)) {
    const match = SCRIPT_LINE.exec(raw.trim());

    if (!match) {continue;}

    const tool = match[1] as string;
    const json = match[2]?.trim() ?? "";
    let args: unknown = {};

    if (json !== "") {
      try {
        args = JSON.parse(json);
      } catch {
        throw new Error(`faux script: arguments for ${tool} are not valid JSON: ${json}`);
      }
    }

    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error(`faux script: arguments for ${tool} must be a JSON object: ${json}`);
    }

    steps.push({ tool, arguments: args as FauxToolStep["arguments"] });
  }

  return steps;
}

function textOf(content: unknown): string {
  if (typeof content === "string") {return content;}

  if (!Array.isArray(content)) {return "";}

  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
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
