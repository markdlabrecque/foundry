/**
 * Prime composition (PRD §5.4.3 "One priming step", §5.5 "Prime").
 *
 * The one daemon-side composer for every Situation. A prime is a short
 * daemon-written header (the worker's `room.station` address, slot and
 * situation, plus the two conventions) followed by the station's configured
 * instruction files in factory → room → station order. Nothing else goes in:
 * no ticket context, no backlog summary, nothing generated.
 *
 * Each composed part carries its source path, relative to the factory YAML's
 * directory, and a SHA-256 content hash. Files are read and hashed at every
 * composition, so an edit takes effect at the next prime. A source that cannot
 * be read fails the composition with a typed result naming the path; freezing
 * the slot on that failure, sending the prime and recording it are the
 * callers' job.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

/** The circumstance a priming answers. */
export type Situation = "fresh" | "recovery" | "compaction";

export interface PrimeRequest {
  /** `room.station`. */
  readonly address: string;
  readonly slotId: string;
  readonly situation: Situation;
  /** The station's isolation; the header states which convention applies. */
  readonly isolation: "none" | "worktree";
  /** Absolute instruction paths in factory → room → station order (`EffectiveStation.instructions`). */
  readonly instructions: ReadonlyArray<string>;
  /** Absolute path of the factory's Knowledge Root. */
  readonly knowledgeRoot: string;
  /** The factory YAML's directory; source paths are reported relative to it. */
  readonly baseDir: string;
}

/** One composed instruction file with its attribution. */
export interface PrimePart {
  /** POSIX path relative to the factory YAML's directory. */
  readonly source: string;
  /** `sha256:<hex>` of the file's bytes as read for this prime. */
  readonly hash: string;
  readonly content: string;
}

export interface Prime {
  readonly situation: Situation;
  /** The full prime text, as injected into the conversation. */
  readonly text: string;
  /** The composed parts in order; their `source` and `hash` are what the daemon records. */
  readonly parts: ReadonlyArray<PrimePart>;
}

/** An instruction source that could not be read at priming time. */
export interface PrimeSourceProblem {
  /** Absolute path that was read. */
  readonly path: string;
  /** POSIX path relative to the factory YAML's directory. */
  readonly source: string;
  readonly reason: "missing" | "unreadable";
  readonly detail: string;
}

export type ComposePrimeResult =
  | { readonly _tag: "Composed"; readonly prime: Prime }
  | { readonly _tag: "SourceUnavailable"; readonly problems: ReadonlyArray<PrimeSourceProblem> };

/** Reads one source's bytes. Injected so composition can run without a filesystem. */
export type ReadSource = (path: string) => Promise<Uint8Array>;

const toSource = (baseDir: string, path: string): string => relative(baseDir, path).split(sep).join("/");

const hashOf = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const isMissing = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;

  return code === "ENOENT" || code === "ENOTDIR";
};

/** What the daemon writes in the prime's header. */
export type PrimeHeader = Pick<PrimeRequest, "address" | "slotId" | "situation" | "isolation" | "knowledgeRoot">;

/**
 * Renders the prime text. Pure: the same header and parts give the same text.
 * `parts` is the authoritative attribution: file content containing
 * `</foundry-source>` can make the text wrapper ambiguous.
 */
export const renderPrime = (header: PrimeHeader, parts: ReadonlyArray<PrimePart>): string => {
  const lines = [
    "# Foundry prime",
    "",
    `Address: ${header.address}`,
    `Slot: ${header.slotId}`,
    `Situation: ${header.situation}`,
    "",
    "Conventions:",
    `- A station with \`isolation: none\` writes only in the ticket directory. This station's isolation is \`${header.isolation}\`.`,
    `- Workers do not write to the knowledge root (\`${header.knowledgeRoot}\`).`,
    "",
    parts.length === 0
      ? "No instruction files are configured for this station."
      : "Configured instructions follow, factory → room → station. Each part names its source path, relative to the factory YAML's directory, and its content hash.",
  ];

  for (const part of parts) {
    const body = part.content.endsWith("\n") ? part.content : `${part.content}\n`;
    lines.push("", `<foundry-source path="${part.source}" hash="${part.hash}">`, `${body}</foundry-source>`);
  }

  return `${lines.join("\n")}\n`;
};

/**
 * Compose a prime, reading and hashing every instruction file now. Every
 * unreadable source is reported, in configured order; no partial prime is
 * returned.
 */
export async function composePrime(
  request: PrimeRequest,
  readSource: ReadSource = (path) => readFile(path),
): Promise<ComposePrimeResult> {
  const reads = await Promise.allSettled(request.instructions.map((path) => readSource(path)));
  const parts: Array<PrimePart> = [];
  const problems: Array<PrimeSourceProblem> = [];
  reads.forEach((outcome, index) => {
    const path = request.instructions[index] as string;
    const source = toSource(request.baseDir, path);

    if (outcome.status === "rejected") {
      problems.push({
        path,
        source,
        reason: isMissing(outcome.reason) ? "missing" : "unreadable",
        detail: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });

      return;
    }

    let content = Buffer.from(outcome.value).toString("utf8");

    if (content.charCodeAt(0) === 0xfe_ff) {content = content.slice(1);}

    parts.push({ source, hash: hashOf(outcome.value), content });
  });

  if (problems.length > 0) {return { _tag: "SourceUnavailable", problems };}

  const text = renderPrime(request, parts);

  return { _tag: "Composed", prime: { situation: request.situation, text, parts } };
}
