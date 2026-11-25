/** Repository Context is an ordinary durable message, pinned to the assignment's slot. */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { slotRecord, ticketRecord } from "./history-records.js";
import { discoverRepositoryContext } from "./repository-context.js";
import { StoreError } from "./store.js";
import type { Change } from "./store.js";

interface ContextPart {
  readonly path: string;
  readonly hash: string;
  readonly content: string;
}

const part = (path: string, content: string): ContextPart => ({
  path, content, hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
});

interface ContextSource {
  readonly factoryId: string;
  readonly slotId: string;
  readonly root: string;
}

interface AssignmentRepositoryContext extends ContextSource {
  readonly body: string;
  readonly parts: ReadonlyArray<{ readonly path: string; readonly hash: string }>;
  readonly conversation: string | null;
}

/** Read afresh; bundle changed context with the assignment before its first turn can start. */
export const composeAssignmentRepositoryContext = (change: Change, input: ContextSource) => Effect.gen(function* () {
  const context = yield* Effect.tryPromise({
    try: () => discoverRepositoryContext(input.root),
    catch: (cause) => new StoreError({ reason: "Sql", message: `cannot discover repository context at ${input.root}`, cause }),
  });

  const parts = [
    ...[context.contextFile, context.appendSystem].flatMap((file) => file === null ? [] : [part(file.path, file.content)]),
    // Hash the indexed header, not the skill body which is deliberately not injected.
    ...context.skills.map((skill) => part(skill.path, JSON.stringify({
      name: skill.name, description: skill.description, path: `${context.worktreeRoot}/${skill.path}`,
    }))),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const pathsAndHashes = parts.map(({ path, hash }) => ({ path, hash }));
  const hashes = JSON.stringify(pathsAndHashes);

  const conversations = yield* change.query<{ ref: string }>(
    `SELECT ref FROM conversation WHERE factory_id = ? AND slot_id = ? AND status = 'current'`,
    [input.factoryId, input.slotId],
  );

  const conversation = conversations[0]?.ref ?? null;

  const previous = yield* change.query<{ parts: string }>(
    `SELECT r.parts FROM repository_context r JOIN message m ON m.id = r.message_id
     WHERE r.factory_id = ? AND r.slot_id = ? AND r.conversation_ref = ? AND m.status = 'acknowledged'
     ORDER BY m.sequence DESC LIMIT 1`,
    [input.factoryId, input.slotId, conversation],
  );

  if (previous[0]?.parts === hashes) {return null;}

  const body = [
    "# Repository Context", `Root: ${context.worktreeRoot}`,
    ...[context.contextFile, context.appendSystem].flatMap((file) => file === null ? [] : [
      `\n## ${file.path}\n${file.content}`,
    ]),
    "\n## Repository skills (read bodies on demand)",
    ...context.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  Path: ${context.worktreeRoot}/${skill.path}`),
    ...(parts.length === 0 ? ["No repository context files or indexed skills."] : []),
  ].join("\n");

  return { ...input, body, parts: pathsAndHashes, conversation } satisfies AssignmentRepositoryContext;
});

/** The same ordinary message carries both contexts: a single injection starts the assignment turn. */
export const recordAssignmentRepositoryContext = (change: Change, input: {
  readonly messageId: string;
  readonly assignmentId: string;
  readonly ticket: number;
  readonly context: AssignmentRepositoryContext;
}) => Effect.gen(function* () {
  const { context } = input;

  yield* change.query(
    `INSERT INTO repository_context (message_id, assignment_id, factory_id, slot_id, conversation_ref, root, parts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.messageId, input.assignmentId, context.factoryId, context.slotId, context.conversation, context.root, JSON.stringify(context.parts)],
  );
  yield* change.recordHistory({
    factoryId: context.factoryId, kind: "repository_context.accepted", subject: input.messageId,
    detail: { assignment: input.assignmentId, slotId: context.slotId, conversationRef: context.conversation, root: context.root, parts: context.parts },
    records: [slotRecord(context.slotId), ticketRecord(input.ticket)],
  });
});
