/**
 * The Foundry extension as a launched worker loads it (PRD §3.2, §5.3): Pi calls the default
 * export of `@foundry/extension`. It reads the launch identity the Worker Host set and the channel
 * socket the daemon named, and at `session_start` dials the daemon with a `hello` carrying them.
 *
 * Daemon frames go to the existing handlers: a prime into the conversation adapter, an interrupt
 * to the run interrupter. Receipts and compaction reports travel back on the attached channel.
 *
 * Terminal hello refusals disable this launch's channel and tools. A general reconnect/backoff
 * loop after a lost channel or retryable refusal remains out of scope.
 */
import { existsSync } from "node:fs";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_DELEGATE, AGENT_DISCOVER, AGENT_MESSAGE, AGENT_REPLY, AGENT_REQUEST, AGENT_STATUS, CHANNEL_SOCKET_ENV, LAUNCH_ENV, PROTOCOL_VERSION, TASK_TRANSITION, HUMAN_REQUEST } from "@foundry/protocol";
import type { Hello, ToolCallOutcome } from "@foundry/protocol";
import { Type } from "typebox";
import { openChannel } from "./channel/client.js";
import type { OpenChannel } from "./channel/client.js";
import { CompactionReporter } from "./compaction.js";
import { createConversationAdapter } from "./conversation/adapter.js";
import { interruptRuns, RunInterrupter } from "./interrupt.js";
import { deliverMessages, MessageReceiver } from "./messages.js";
import { InjectionReporter } from "./injections.js";
import { ReceiptReporter, receiveDaemonFrames } from "./priming.js";
import { ToolCallClient } from "./tool-calls.js";
import { registeredToolSet } from "./tool-set.js";

/** What a launch tells its worker through the environment. */
export interface WorkerLaunch {
  readonly socketPath: string;
  readonly factoryId: string;
  readonly slotId: string;
  readonly launchId: string;
}

/**
 * The launch this process runs as, or `undefined` outside a Foundry launch (any variable unset or
 * empty), so loading the extension elsewhere does nothing.
 */
export const workerLaunchFrom = (env: Readonly<Record<string, string | undefined>>): WorkerLaunch | undefined => {
  const socketPath = env[CHANNEL_SOCKET_ENV];
  const factoryId = env[LAUNCH_ENV.factoryId];
  const slotId = env[LAUNCH_ENV.slotId];
  const launchId = env[LAUNCH_ENV.launchId];

  if (!socketPath || !factoryId || !slotId || !launchId) {return undefined;}

  return { socketPath, factoryId, slotId, launchId };
};

/**
 * The hello for the current session. The conversation reference is Pi's session ID. History is
 * recoverable once Pi has written the session file, which a relaunch restores from.
 */
const helloFor = (pi: ExtensionAPI, launch: WorkerLaunch, ctx: ExtensionContext): Hello => {
  const sessionFile = ctx.sessionManager.getSessionFile();

  return {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    factoryId: launch.factoryId,
    slotId: launch.slotId,
    launchId: launch.launchId,
    conversationRef: ctx.sessionManager.getSessionId(),
    hasRecoverableHistory: sessionFile !== undefined && existsSync(sessionFile),
    mode: "headless",
    tools: registeredToolSet(pi),
  };
};

/** Register the worker's channel on `pi` for `launch`. */
export const connectWorker = (pi: ExtensionAPI, launch: WorkerLaunch): void => {
  const interrupter = new RunInterrupter();
  interruptRuns(pi, interrupter);
  const receipts = new ReceiptReporter();
  const injections = new InjectionReporter();

  const adapter = createConversationAdapter(pi, { onReceipt: (id) => {
    injections.forget(id);
    receipts.record(id);
  } });

  const messages = new MessageReceiver(adapter, injections.record);
  deliverMessages(pi, messages);
  const compactions = new CompactionReporter();
  pi.on("session_compact", () => compactions.record());

  const toolCalls = new ToolCallClient();

  for (const tool of [
    { name: AGENT_DISCOVER, label: "Discover stations and slots", description: "List the configured stations and slots in your factory." },
    { name: AGENT_STATUS, label: "Inspect station and slot availability", description: "Inspect your factory's station capacity and recorded slot conditions and launch state. Normal or unended does not prove idle, reachable, or host-confirmed vacant capacity." },
  ]) {
    pi.registerTool({
      ...tool,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(callId): Promise<AgentToolResult<ToolCallOutcome>> {
        const outcome = await toolCalls.call(callId, tool.name, {});

        if (outcome.status === "committed") {
          return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
        }

        const code = outcome.status === "refused" ? outcome.code : outcome.status;

        return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
      },
    });
  }

  pi.registerTool({
    name: AGENT_MESSAGE,
    label: "Send a durable message",
    description: "Send a durable ordinary message to a station in your factory. Acceptance is not delivery or completion.",
    parameters: Type.Object({
      recipient: Type.String({ minLength: 1 }),
      body: Type.String(),
      delivery: Type.Optional(Type.Union([Type.Literal("after_turn"), Type.Literal("when_idle")])),
    }, { additionalProperties: false }),
    async execute(callId, args): Promise<AgentToolResult<ToolCallOutcome>> {
      const outcome = await toolCalls.call(callId, AGENT_MESSAGE, args);

      if (outcome.status === "committed") {
        return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
      }

      const code = outcome.status === "refused" ? outcome.code : outcome.status;

      return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
    },
  });

  pi.registerTool({
    name: AGENT_REQUEST,
    label: "Send an asynchronous request",
    description: "Ask a station in your factory for a reply. Returns requestId and an absolute Unix-millisecond deadline after durable acceptance, without waiting for delivery or a reply.",
    parameters: Type.Object({
      recipient: Type.String({ minLength: 1 }),
      body: Type.String(),
      timeoutMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      delivery: Type.Optional(Type.Union([Type.Literal("after_turn"), Type.Literal("when_idle")])),
    }, { additionalProperties: false }),
    async execute(callId, args): Promise<AgentToolResult<ToolCallOutcome>> {
      const outcome = await toolCalls.call(callId, AGENT_REQUEST, args);

      if (outcome.status === "committed") {
        return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
      }

      const code = outcome.status === "refused" ? outcome.code : outcome.status;

      return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
    },
  });

  pi.registerTool({
    name: AGENT_DELEGATE,
    label: "Delegate within the current ticket",
    description: "Create a tracked obligation and notice in the current ticket. For a child, provide the open parentDelegationId selected for your slot. Returns after durable acceptance, not completion.",
    parameters: Type.Object({
      recipient: Type.String({ minLength: 1 }),
      body: Type.String(),
      parentDelegationId: Type.Optional(Type.String({ minLength: 1 })),
      delivery: Type.Optional(Type.Union([Type.Literal("after_turn"), Type.Literal("when_idle")])),
    }, { additionalProperties: false }),
    async execute(callId, args): Promise<AgentToolResult<ToolCallOutcome>> {
      const outcome = await toolCalls.call(callId, AGENT_DELEGATE, args);

      if (outcome.status === "committed") {
        return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
      }

      const code = outcome.status === "refused" ? outcome.code : outcome.status;

      return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
    },
  });

  pi.registerTool({
    name: AGENT_REPLY,
    label: "Reply to a request or resolve a delegation",
    description: "From the selected recipient slot, reply with requestId and body, or resolve a delegation with delegationId, an explicit outcome and evidence. A request's first reply before its deadline completes it; late replies are recorded but not delivered. A delegation result returns to its delegating slot; acknowledgement alone is not resolution.",
    parameters: Type.Union([
      Type.Object({
        requestId: Type.String({ minLength: 1 }),
        body: Type.String(),
      }, { additionalProperties: false }),
      Type.Object({
        delegationId: Type.String({ minLength: 1 }),
        outcome: Type.String({ minLength: 1 }),
        evidence: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
    ]),
    async execute(callId, args): Promise<AgentToolResult<ToolCallOutcome>> {
      const outcome = await toolCalls.call(callId, AGENT_REPLY, args);

      if (outcome.status === "committed") {
        return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
      }

      const code = outcome.status === "refused" ? outcome.code : outcome.status;

      return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
    },
  });

  pi.registerTool({
    name: TASK_TRANSITION,
    label: "Report an assignment outcome",
    description: "Report done, blocked or rejected for your active assignment with reason and evidence references. Blocked and rejected without a configured rejection route pause for an operator decision. The daemon chooses routing; you cannot choose a destination. Code-stage done requires the exact ticket branch HEAD commit; all non-writing outcomes require reverting branch movement and tracked changes. Routed rejection and done at approval or final stages are not supported yet.",
    parameters: Type.Object({
      assignmentId: Type.String({ minLength: 1 }),
      outcome: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("rejected")]),
      reason: Type.String({ minLength: 1 }),
      evidence: Type.Array(Type.String({ minLength: 1 })),
      gitCommit: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(callId, args): Promise<AgentToolResult<ToolCallOutcome>> {
      const outcome = await toolCalls.call(callId, TASK_TRANSITION, args);

      if (outcome.status === "committed") {
        return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
      }

      const code = outcome.status === "refused" ? outcome.code : outcome.status;

      return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
    },
  });

  pi.registerTool({
    name: HUMAN_REQUEST,
    label: "Ask the operator for a decision",
    description: "Record a worker-request approval for your active assignment without pausing or gating stage movement. Returns after durable acceptance; the operator answer is asynchronous.",
    parameters: Type.Object({
      assignmentId: Type.String({ minLength: 1 }),
      body: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(callId, args): Promise<AgentToolResult<ToolCallOutcome>> {
      const outcome = await toolCalls.call(callId, HUMAN_REQUEST, args);

      if (outcome.status === "committed") {
        return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], details: outcome };
      }

      const code = outcome.status === "refused" ? outcome.code : outcome.status;

      return { content: [{ type: "text", text: `${code}: ${outcome.detail}` }], details: outcome, isError: true };
    },
  });

  const onFrame = receiveDaemonFrames({ adapter, messages, interrupter, toolCalls });
  let channel: OpenChannel | undefined;
  let dialling = false;

  pi.on("session_start", async (_event, ctx) => {
    // One dial per launch for now: a later `session_start` (`/new`, `/resume`, `/reload`) on a live
    // channel is not re-announced. Conversation-change handling belongs to the reconnect work.
    if (toolCalls.terminallyRefused || channel !== undefined || dialling) {return;}

    dialling = true;

    try {
      const opened = await openChannel({ socketPath: launch.socketPath, hello: helloFor(pi, launch, ctx), onFrame });

      if (!opened.accepted) {
        toolCalls.refuse(opened.reason);
        // The host keeps the launch's stderr, so a worker that never connects can be diagnosed.
        process.stderr.write(`foundry: channel hello refused (${opened.reason.kind} ${opened.reason.code})\n`);

        return;
      }

      channel = opened.channel;
      injections.attach(opened.channel);
      receipts.attach(opened.channel);
      compactions.attach(opened.channel);
      toolCalls.attach(opened.channel);
      void opened.channel.closed.then(() => {
        if (channel === opened.channel) {channel = undefined;}
      });
    } catch (cause) {
      // No daemon answered. Pi keeps running; reconnecting is not part of this extension yet.
      process.stderr.write(`foundry: channel not reached at ${launch.socketPath}: ${String(cause)}\n`);
    } finally {
      dialling = false;
    }
  });
  pi.on("session_shutdown", () => {
    channel?.close();
    channel = undefined;
  });
};

/** Pi's entry point: connect when running as a Foundry launch, otherwise do nothing. */
export default function foundryWorker(pi: ExtensionAPI): void {
  const launch = workerLaunchFrom(process.env);

  if (launch !== undefined) {connectWorker(pi, launch);}
}
