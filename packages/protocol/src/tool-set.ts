/**
 * The fixed part of every worker's Tool Set and the tool-name rules (PRD §3.2 "Tool Set", §4
 * "Extension tools"). Defined once here: the daemon validates and resolves Tool Sets, the
 * Worker Host puts them on the launch command, and the extension reports them in `hello`.
 */

/** Pi's four built-in tools every worker has, in launch order. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

/** The eight P0 agent tools the Foundry extension registers (PRD §6.1). */
export const AGENT_TOOLS = [
  "agent_discover",
  "agent_status",
  "agent_message",
  "agent_request",
  "agent_reply",
  "agent_delegate",
  "task_transition",
  "human_request",
] as const;

/**
 * The agent tools the Foundry extension in this build actually registers. The `hello` check
 * expects only these from the Foundry extension, so a worker is not frozen for agent tools no
 * build can offer yet. Staged: empty until the agent tools land (FOU-36), which sets it to
 * `AGENT_TOOLS`. Until then an agent tool reported by a worker is an extra tool.
 */
export const REGISTERED_AGENT_TOOLS: ReadonlyArray<string> = [];

/** How the extension reports a Pi built-in's source: `builtin:<name>` (Pi's own attribution). */
export const builtinToolSource = (name: string): string => `builtin:${name}`;

/** The twelve fixed tools of every worker's Tool Set, in launch order. */
export const FIXED_TOOLS: ReadonlyArray<string> = [...PI_BUILTIN_TOOLS, ...AGENT_TOOLS];

/**
 * Every tool Pi 1.6.0 builds in, enabled or not. All are reserved, not only the four a
 * worker gets. The host's tests pin this against the installed Pi's own list.
 */
export const PI_ALL_BUILTIN_TOOLS: ReadonlyArray<string> = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

/** Exact names no configured extension may contribute, besides the `mcp__` prefix. */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PI_ALL_BUILTIN_TOOLS,
  ...AGENT_TOOLS,
  "codemode",
  "tool_search",
]);

/** Prefix of MCP tool names; every name with it is reserved. */
export const RESERVED_TOOL_PREFIX = "mcp__";

/** A plain, exact tool name: no patterns, and nothing that could split Pi's `--tools` list. */
export const isPlainToolName = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name);

/** Whether an extension may not contribute this tool name (PRD §4). */
export const isReservedToolName = (name: string): boolean =>
  RESERVED_TOOL_NAMES.has(name) || name.startsWith(RESERVED_TOOL_PREFIX);
