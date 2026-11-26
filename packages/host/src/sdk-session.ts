/** Experimental SDK adapter. It uses the same Foundry extension and channel as RPC;
 * it does not add reconnect behaviour or qualify the SDK launcher (PRD §17.2).
 */
import { join } from "node:path";
import { agentToolCollisions } from "./sdk-diagnostic.js";
import type { StartupDiagnostic } from "./sdk-diagnostic.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface SdkSessionInputs {
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: string;
  readonly conversationRef: string;
  readonly extensions: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
}

/** Explicit resources only: never load settings, instructions, MCP or ambient packages.
 * The host still passes its full environment; credential isolation is not claimed here.
 */
export async function createSdkSession(inputs: SdkSessionInputs, reportStartupCollision?: (diagnostic: StartupDiagnostic) => void) {
  const settingsManager = SettingsManager.inMemory();

  const resourceLoader = new DefaultResourceLoader({
    cwd: inputs.cwd,
    agentDir: inputs.agentDir,
    settingsManager,
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    appendSystemPrompt: [""],
    additionalExtensionPaths: [...inputs.extensions],
    additionalSkillPaths: [...inputs.skills],
  });

  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  const collisions = agentToolCollisions(loaded.extensions);

  if (collisions.length > 0) {
    reportStartupCollision?.({ version: 1, kind: "agent_tool_collision", collisions });
    throw new Error(`SDK agent tool collision: ${collisions.map((c) => `${c.name}: ${c.sources.join(", ")}`).join("; ")}`);
  }

  if (loaded.errors.length > 0) {throw new Error(`SDK extension load failed: ${loaded.errors.map((error) => error.path).join(", ")}`);}

  const modelRuntime = await ModelRuntime.create({ authPath: join(inputs.agentDir, "auth.json"), modelsPath: null });
  const sessionDir = join(inputs.cwd, "sessions");
  const existing = SessionManager.findById(inputs.cwd, inputs.conversationRef, sessionDir);

  const sessionManager = existing === undefined
    ? SessionManager.create(inputs.cwd, sessionDir, { id: inputs.conversationRef })
    : SessionManager.open(existing, sessionDir, inputs.cwd);

  const { session } = await createAgentSession({
    cwd: inputs.cwd,
    agentDir: inputs.agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager,
    noTools: "all",
    tools: [...inputs.tools],
  });

  try {
    // Session construction registers extension providers. Select the exact model before
    // session_start opens the channel: delivery may arrive as soon as hello is accepted.
    const slash = inputs.model.indexOf("/");
    const model = slash > 0 ? modelRuntime.getModel(inputs.model.slice(0, slash), inputs.model.slice(slash + 1)) : undefined;

    if (!model) {throw new Error(`SDK model is not registered: ${inputs.model}`);}

    await session.setModel(model);
    await session.bindExtensions({});
  } catch (error) {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    throw error;
  }

  return { session, resourceLoader };
}
