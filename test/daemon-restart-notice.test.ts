// Tier: integration. Real boundaries: the Unix-socket channel between two successive daemon
// instances and one surviving worker launch, the extension's tool-call client, and one SQLite store
// file. The worker's conversation is a scripted double that answers reconciliation as idle. Claim
// (PRD §10.2): after a daemon restart, a worker that survived is not primed again, gets exactly one
// resume notice for its still-active assignment and none for an assignment it already ended, and
// no committed tool call takes effect twice. Eligibility rules are proved at the cheaper tier in
// packages/daemon/test/recovery-notice.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Effect, Exit, Schema, Scope } from "effect";
import {
  acknowledgeMessage, createAssignmentScheduler, createChannelAssignmentGate, createMessageDelivery, createPrimer, createReconciler,
  createSubmissions, createTicketService, openSlotGate, openStore, planSlots, startChannelServer,
  recoverConnection, taskTransitionHandler, ticketFactoryFrom,
} from "@foundry/daemon";
import type { ChannelServer, Store, ToolHandler } from "@foundry/daemon";
import { FactoryConfig } from "@foundry/daemon/config";
import { openChannel, ToolCallClient } from "@foundry/extension";
import type { OpenChannel } from "@foundry/extension";
import { PROTOCOL_VERSION, TASK_TRANSITION } from "@foundry/protocol";
import type { DaemonFrame, Hello } from "@foundry/protocol";

const config = Schema.decodeUnknownSync(FactoryConfig)({
  version: 1, name: "shop", repository: { source: "/disposable", default_branch: "main" },
  default_production_line: "standard", rooms: { floor: { stations: { worker: {} } } },
  production_lines: { standard: { stages: [{ id: "plan", station: "floor.worker" }, { id: "review", station: "floor.worker" }] } },
});

const slots = planSlots("shop", [{ address: "floor.worker", room: "floor", station: "worker", model: "fake/model",
  instructions: [], skills: [], extensions: [], instances: 1, isolation: "none" }]);

const slot = { factoryId: "shop", slotId: "worker/1", launchId: "surviving-launch" };

const hello: Hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, ...slot, conversationRef: "conversation",
  hasRecoverableHistory: false, mode: "headless", tools: [] };

/** The only effect of the test tool: one history row per executed call. */
const echo: ToolHandler = (change, call) => Effect.as(
  change.recordHistory({ factoryId: call.factoryId, kind: "test.effect", subject: call.callId }), { ok: true });

let dir: string;
let scope: Scope.Closeable;
let store: Store;
let assignmentId: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-restart-notice-"));
  scope = await Effect.runPromise(Scope.make());
  store = await Effect.runPromise(openStore({ filename: join(dir, "state.db") }).pipe(Scope.provide(scope)));
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`INSERT INTO slot (factory_id, slot_id, station, ordinal, condition, current_launch)
      VALUES ('shop', 'worker/1', 'floor.worker', 1, 'normal', ?)`, [slot.launchId]);
    yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "slot" });
  })));
  const tickets = createTicketService({ store, stateRoot: dir, factories: () => [ticketFactoryFrom(config)] });
  await Effect.runPromise(tickets.submit({ title: "Survives a daemon restart", spec: "disposable" }));
  const [assignment] = await Effect.runPromise(createAssignmentScheduler({ store, slots, factories: [{ factoryId: "shop", config }] }).schedule());

  if (assignment === undefined) {throw new Error("missing fixture assignment");}

  assignmentId = assignment.id;
  // Routing is not under test: bind the assignment context to the slot, as the router would.
  await Effect.runPromise(store.change((change) => Effect.gen(function* () {
    yield* change.query(`UPDATE message SET status = 'bound', bound_slot = ? WHERE id = ?`, [slot.slotId, assignment.contextMessage]);
    yield* change.recordHistory({ factoryId: "shop", kind: "fixture", subject: "routed-context" });
  })));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}

  await Effect.runPromise(Scope.close(scope, Exit.void));
  await rm(dir, { recursive: true, force: true });
});

/** One daemon run over the shared store using the production accepted-connection recovery barrier. */
const startDaemon = async () => {
  const reconciler = createReconciler(store);
  let primeIds = 0;

  const primer = createPrimer({ store, newPrimeId: () => `prime-${++primeIds}`, primeRequest: () => ({ address: "floor.worker",
    slotId: slot.slotId, isolation: "none", instructions: [], knowledgeRoot: join(dir, "knowledge"), baseDir: dir }) });

  const errors: Array<unknown> = [];
  const delivery = createMessageDelivery({ store, gate: openSlotGate, onError: (cause) => errors.push(cause) });
  const gate = createChannelAssignmentGate();
  const stages: Array<{ stage: string; open: boolean }> = [];
  const stage = (name: string) => { stages.push({ stage: name, open: gate.isOpen(slot.factoryId, slot.slotId) }); };

  gate.onOpened(() => stage("opened"));
  let ready!: () => void;
  const recovered = new Promise<void>((resolve) => { ready = resolve; });
  let toolCalls = 0;
  let heartbeat!: () => void;
  const workerBarrier = new Promise<void>((resolve) => { heartbeat = resolve; });
  let receipts = 0;
  const receiptWaiters: Array<{ count: number; resolve: () => void }> = [];

  const server: ChannelServer = await startChannelServer({
    socketPath: join(dir, "channel.sock"),
    slotClaim: { claim: async () => ({ accepted: true, slot }) },
    toolCalls: createSubmissions({ store, handlers: new Map([["echo", echo],
      [TASK_TRANSITION, taskTransitionHandler({ factories: [{ factoryId: "shop", config }] })]]) }),
    onAccepted: (claimed, greeting, connection) => {
      void recoverConnection({
        gate,
        reconciler: {
          reconcile: async (...args) => {
            stage("reconciling");
            const comparison = await reconciler.reconcile(...args);
            stage("reconciled");

            return comparison;
          },
          resumeAssignment: async (...args) => {
            stage("resuming");
            const notice = await reconciler.resumeAssignment(...args);
            stage("resumed");

            return notice;
          },
        },
        primer: { prime: (...args) => {
          stage("priming");

          return primer.prime(...args);
        } },
        delivery: { attach: (...args) => {
          stage("attaching");
          delivery.attach(...args);
          stage("attached");
        } },
        notTakingWork: (reason) => errors.push(reason),
        onError: (cause) => errors.push(cause),
      }, claimed, greeting, connection).then(ready);
    },
    onFrame: (claimed, frame) => {
      if (frame.type === "tool_call") {toolCalls += 1;}

      if (frame.type === "heartbeat") {heartbeat();}

      if (frame.type === "reconciliation_answer") {
        reconciler.receive(claimed, frame);
      } else if (frame.type === "receipt") {
        void (async () => {
          if (await primer.receipt(claimed, frame.id) === "unknown") {await Effect.runPromise(acknowledgeMessage(store, claimed, frame.id));}

          receipts += 1;

          for (const waiter of receiptWaiters.filter((w) => receipts >= w.count)) {
            receiptWaiters.splice(receiptWaiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        })().catch((cause: unknown) => errors.push(cause));
      }
    },
  });

  const stop = async () => { await server.close(); await delivery.stop(); };

  cleanups.push(stop);

  return {
    server, recovered, delivery, errors, stop, gate, stages, workerBarrier,
    toolCalls: () => toolCalls,
    /** Resolves once this daemon has recorded at least `count` receipts. */
    receipts: (count: number) => receipts >= count ? Promise.resolve()
      : new Promise<void>((resolve) => { receiptWaiters.push({ count, resolve }); }),
  };
};

/** The surviving worker: one launch, one tool-call client, reconnecting to whichever daemon is up. */
const client = new ToolCallClient({ timer: () => () => {} });

const connect = async (server: ChannelServer, frames: Array<DaemonFrame>, recoverable: boolean): Promise<OpenChannel> => {
  const opened = await openChannel({ socketPath: server.socketPath, hello: { ...hello, hasRecoverableHistory: recoverable },
    heartbeatIntervalMs: 60_000, onFrame: (frame, channel) => {
      frames.push(frame);

      if (frame.type === "prime" || frame.type === "message") {void channel.send({ type: "receipt", id: frame.id }).catch(() => {});}

      if (frame.type === "tool_result") {client.receive(frame);}

      if (frame.type === "reconcile") {
        void channel.send({ type: "reconciliation_answer", requestId: frame.requestId, lifecycle: "idle",
          answers: frame.ids.map((id) => ({ id, status: "history" as const })) }).catch(() => {});
      }
    } });

  if (!opened.accepted) {throw new Error("fixture hello refused");}

  cleanups.push(() => opened.channel.close());
  client.attach(opened.channel);

  return opened.channel;
};

/** Bounded, so a missing step fails naming the step rather than as a vitest timeout. */
const within = <A>(step: string, promise: Promise<A>): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${step}`)), 2000).unref(); }),
  ]);

const read = <A extends object>(sql: string, params: ReadonlyArray<string> = []) => Effect.runPromise(store.read<A>(sql, [...params]));

test.each([
  { name: "still-active assignment gets one notice", call: { tool: "echo", args: {} }, notified: true },
  { name: "assignment it ended before the restart gets none", call: { tool: TASK_TRANSITION, args: undefined }, notified: false },
] as const)("a worker that survives a daemon restart is not re-primed or replayed: $name", async ({ call, notified }) => {
  // First daemon run: fresh prime and assignment context delivered and acknowledged, then one tool call commits.
  const first = await startDaemon();
  const before: Array<DaemonFrame> = [];
  const firstChannel = await connect(first.server, before, false);
  await within("first recovery", first.recovered);
  await first.receipts(2);
  const args = call.args ?? { assignmentId, outcome: "done", reason: "finished before the daemon died", evidence: [] };
  expect(await client.call("call-1", call.tool, args)).toMatchObject({ status: "committed" });
  expect(before.map((frame) => frame.type)).toEqual(["prime", "message", "tool_result"]);

  // The daemon dies; the worker's launch lives on and reconnects to the next daemon run.
  await first.stop();
  await firstChannel.closed;
  const second = await startDaemon();
  const after: Array<DaemonFrame> = [];
  const secondChannel = await connect(second.server, after, true);
  await within("restart recovery", second.recovered);
  await second.delivery.idle();
  // attach() replays pending calls synchronously. A later worker frame on the same stream
  // is a deterministic barrier: the daemon has observed any replay, including cached same-ID calls.
  await secondChannel.send({ type: "heartbeat" });
  await within("worker recovery barrier", second.workerBarrier);
  expect(second.toolCalls()).toBe(0);
  expect(second.stages).toEqual([
    ...["reconciling", "reconciled", "priming", "resuming", "resumed", "attaching", "attached"]
      .map((stage) => ({ stage, open: false })),
    { stage: "opened", open: true },
  ]);

  const notices = await read<{ id: string; body: string }>(`SELECT id, body FROM message WHERE kind = 'resume_notice'`);

  if (notified) {
    // The notice's receipt proves its frame reached the worker before the frames are compared.
    await within("the notice receipt", second.receipts(1));
    expect(notices).toEqual([{ id: expect.any(String), body: expect.stringContaining(`Assignment: ${assignmentId}`) }]);
    expect(notices[0]?.body).toContain("do not replay tool calls blindly");
    expect(after).toEqual([
      expect.objectContaining({ type: "reconcile", ids: [] }),
      { type: "message", id: notices[0]?.id, body: notices[0]?.body, delivery: "after_turn" },
    ]);
  } else {
    // Nothing is pending and no assignment is active, so the daemon has nothing to compare or say.
    expect(notices).toEqual([]);
    expect(after).toEqual([]);
  }

  // Preserve the committed tool effects without duplication, under the surviving launch.
  expect(await read(`SELECT launch_id, call_id, tool FROM submission`)).toEqual([{ launch_id: slot.launchId, call_id: "call-1", tool: call.tool }]);
  expect(await read(`SELECT subject FROM history WHERE kind IN ('test.effect', 'ticket.transitioned')`)).toHaveLength(1);
  expect(await read(`SELECT id, situation FROM prime`)).toEqual([{ id: "prime-1", situation: "fresh" }]);
  expect([...first.errors, ...second.errors]).toEqual([]);
  await second.stop();
  expect(second.gate.isOpen(slot.factoryId, slot.slotId)).toBe(false);
});
