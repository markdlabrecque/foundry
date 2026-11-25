/** Repository Context is an ordinary durable message, pinned to the assignment's slot. */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { acceptMessage } from "./agent-message.js";
import { slotRecord, ticketRecord } from "./history-records.js";
import { discoverRepositoryContext } from "./repository-context.js";
import type { Change, Store } from "./store.js";

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
  /** Compaction discarded context even when the last received hashes match. */
  readonly force?: boolean;
}

interface AssignmentRepositoryContext extends ContextSource {
  readonly body: string;
  readonly parts: ReadonlyArray<{ readonly path: string; readonly hash: string }>;
  readonly conversation: string | null;
}

/** Read afresh; bundle changed context with the assignment before its first turn can start. */
export const composeAssignmentRepositoryContext = (change: Change, input: ContextSource) => Effect.gen(function* () {
  // main imports the store through quiet-store before assigning. A static import here
  // would load node:sqlite too early and leak its warning into the daemon log stream.
  const { StoreError } = yield* Effect.promise(() => import("./store.js"));

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

  if (!input.force && previous[0]?.parts === hashes) {return null;}

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

const unassigned = Symbol("unassigned");

/** Re-read the active assignment after the prime; an idle or suspended slot gets nothing. */
export const resendAssignmentRepositoryContext = (store: Store, input: {
  readonly factoryId: string;
  readonly slotId: string;
  readonly clonePath: string;
  readonly isolation: "worktree" | "none";
}) => store.change((change) => Effect.gen(function* () {
  const assignments = yield* change.query<{ id: string; ticket_number: number; station: string; worktree_path: string | null }>(
    `SELECT a.id, a.ticket_number, s.station, t.worktree_path FROM assignment a
     JOIN ticket t ON t.factory_id = a.factory_id AND t.number = a.ticket_number
     JOIN slot s ON s.factory_id = a.factory_id AND s.slot_id = a.slot_id
     WHERE a.factory_id = ? AND a.slot_id = ? AND a.status = 'active'`,
    [input.factoryId, input.slotId],
  );

  const assignment = assignments[0];

  if (assignment === undefined) {return yield* Effect.fail(unassigned);}

  const context = yield* composeAssignmentRepositoryContext(change, {
    factoryId: input.factoryId, slotId: input.slotId, force: true,
    root: input.isolation === "worktree" && assignment.worktree_path !== null ? assignment.worktree_path : input.clonePath,
  });

  if (context === null) {return yield* Effect.fail(unassigned);}

  const message = yield* acceptMessage(change, {
    factoryId: input.factoryId, senderKind: "daemon", senderSlot: null, recipient: assignment.station,
    kind: "ordinary", delivery: "after_turn", correlation: { ticket: assignment.ticket_number }, body: context.body,
  }).pipe(Effect.catchTag("ToolRefusal", Effect.die));

  yield* recordAssignmentRepositoryContext(change, {
    messageId: message.id, assignmentId: assignment.id, ticket: assignment.ticket_number, context,
  });
})).pipe(Effect.catchIf((error) => error === unassigned, () => Effect.void));

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
