/** The Worker Host: owns worker launches and resolves the pinned pi binary. */
export const packageName = "@foundry/host" as const;

export {
  AGENT_TOOLS,
  FIXED_TOOLS,
  LAUNCH_ENV,
  PI_BIN_ENV,
  PI_BUILTIN_TOOLS,
  SUPPRESSION_FLAGS,
  buildLaunchCommand,
  resolvePiExecutable,
} from "./launch-command.js";
export type { ConfiguredExtension, LaunchCommand, LaunchInputs, PiExecutable } from "./launch-command.js";
