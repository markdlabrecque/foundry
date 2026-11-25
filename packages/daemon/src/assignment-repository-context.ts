/** Repository Context is an ordinary durable message, pinned to the assignment's slot. */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { acceptMessage } from "./agent-message.js";
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

/** Read afresh at every assignment; only acknowledged context in this conversation can deduplicate. */
export const acceptAssignmentRepositoryContext = (change: Change, input: {
  readonly factoryId: string;
  readonly slotId: string;
  readonly recipient: string;
  readonly ticket: number;
  readonly assignmentId: string;
  readonly root: string;
}) => Effect.gen(function* () {
  const context = yield* Effect.tryPromise({
    try: () => discoverRepositoryContext(input.root),
    catch: (cause) => new StoreError({ reason: "Sql", message: `cannot discover repository context at ${input.root}`, cause }),
  });

  const parts = [
    ...[context.contextFile, context.appendSystem].flatMap((file) => file === null ? [] : [part(file.path, file.content)]),
    // Hash the indexed header, not the skill body which is deliberately not injected.
    ...context.skills.map((skill) => part(skill.path, JSON.stringify({ name: skill.name, description: skill.description }))),
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

  if (previous[0]?.parts === hashes) {return;}

  const body = [
    "# Repository Context", `Root: ${context.worktreeRoot}`,
    ...[context.contextFile, context.appendSystem].flatMap((file) => file === null ? [] : [
      `\n## ${file.path}\n${file.content}`,
    ]),
    "\n## Repository skills (read bodies on demand)",
    ...context.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  Path: ${context.worktreeRoot}/${skill.path}`),
    ...(parts.length === 0 ? ["No repository context files or indexed skills."] : []),
  ].join("\n");

  const message = yield* acceptMessage(change, {
    factoryId: input.factoryId, senderKind: "daemon", senderSlot: null, recipient: input.recipient,
    correlation: { ticket: input.ticket }, kind: "ordinary", delivery: "after_turn", body,
  }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

  yield* change.query(
    `INSERT INTO repository_context (message_id, assignment_id, factory_id, slot_id, conversation_ref, root, parts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [message.id, input.assignmentId, input.factoryId, input.slotId, conversation, input.root, hashes],
  );
  yield* change.recordHistory({
    factoryId: input.factoryId, kind: "repository_context.accepted", subject: message.id,
    detail: { assignment: input.assignmentId, slotId: input.slotId, conversationRef: conversation, root: input.root, parts: pathsAndHashes },
    records: [slotRecord(input.slotId), ticketRecord(input.ticket)],
  });
});
