/**
 * A real Pi 1.6.0 session run in-process through the SDK, with the
 * credential-free faux model, given inline extensions and every Pi directory
 * under `root`. No operator state, credential or network is used. The caller
 * disposes the session and removes `root`.
 */
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FAUX_MODEL, FAUX_PROVIDER } from "./faux-provider.js";
import { FAUX_PROVIDER_EXTENSION } from "./launch.js";

export interface FauxSessionOptions {
  /** Disposable directory; the agent dir, cwd and sessions all live under it. */
  readonly root: string;
  readonly extensionFactories: ReadonlyArray<ExtensionFactory>;
}

export const startFauxSession = async (options: FauxSessionOptions): Promise<AgentSession> => {
  const agentDir = join(options.root, "agent");
  const cwd = join(options.root, "work");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [FAUX_PROVIDER_EXTENSION],
    extensionFactories: [...options.extensionFactories],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(options.root, "sessions")),
    noTools: "all",
  });
  try {
    await session.bindExtensions({});
    const model = modelRuntime.getModel(FAUX_PROVIDER, FAUX_MODEL);
    if (!model) throw new Error("faux model not registered");
    await session.setModel(model);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
};
