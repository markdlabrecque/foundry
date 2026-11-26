// Standalone Pi resource-loader diagnostic only: retain the collision detail the SDK
// adapter's early error reduces to a path. No session, model selection or prompt.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = mkdtempSync(join(tmpdir(), "f153-load-"));
const cwd = join(root, "slot");
const agentDir = join(root, "agent");
const user = join(root, "user");
for (const path of [cwd, agentDir, user]) mkdirSync(path);
const originalEnv = {...process.env};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {PATH: originalEnv.PATH, TMPDIR: originalEnv.TMPDIR, HOME: user,
  XDG_CONFIG_HOME: join(user, ".config"), XDG_DATA_HOME: join(user, ".local/share"),
  XDG_CACHE_HOME: join(user, ".cache"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0"});
try {
  globalThis.fetch = () => { throw new Error("FOU-153 loader diagnostic forbids fetch"); };
  // Foundry registers its tools only when launch identity exists. No bindExtensions or
  // session_start is called, so this nonexistent private socket is never dialed.
  Object.assign(process.env, { FOUNDRY_CHANNEL_SOCKET: join(root, "absent.sock"), FOUNDRY_FACTORY_ID: "probe", FOUNDRY_SLOT: "dev/1", FOUNDRY_LAUNCH_ID: "loader-diagnostic" });
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true,
    disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: "", appendSystemPrompt: [""],
    additionalExtensionPaths: [resolve("packages/extension/dist/index.js"), resolve("docs/evidence/rpc-53-3-linux/fixtures/agent-name.ts")],
    additionalSkillPaths: [],
  });
  await loader.reload();
  console.log(JSON.stringify(loader.getExtensions().errors, null, 2));
} finally { rmSync(root, {recursive: true, force: true}); }
