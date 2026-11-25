/** The Worker Host: owns worker launches and resolves the pinned pi binary. */
export const packageName = "@foundry/host" as const;

export {
  HOST_CONTROL_VERSION,
  HOST_SOCKET_NAME,
  hostSocketPath,
  type HostEvent,
  type HostIdentity,
  type HostRequest,
  type HostResponse,
  type LaunchExitedEvent,
  type TerminateRequest,
} from "./control.js";
export type { LaunchExit, LaunchRecord, LaunchSpec, TerminateOptions, Termination } from "./launches.js";
export { createLaunchRegistry, type LaunchRegistry } from "./launches.js";
export { serveHost, type RunningHost } from "./server.js";
export { terminateGroup, type GroupSignal, type GroupTermination, type TerminateGroupDeps } from "./terminate.js";
export {
  HOST_LOG_NAME,
  connectHost,
  hostLogPath,
  startHost,
  type ConnectHostOptions,
  type HostConnection,
  type StartHostOptions,
} from "./client.js";
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
