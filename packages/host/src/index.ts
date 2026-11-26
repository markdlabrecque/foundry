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

export { endedUnexpectedly, exitWasUnexpected, serveHost, type RunningHost } from "./server.js";

export { terminateGroup, type GroupSignal, type GroupTermination, type TerminateGroupDeps } from "./terminate.js";

export {
  LAUNCH_LOGS_DIR,
  LAUNCH_STDERR_KEEP_PER_SLOT,
  LAUNCH_STDERR_TAIL_BYTES,
  launchStderrPath,
} from "./log.js";

export {
  HOST_LOG_NAME,
  HostRefusedError,
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
  buildLaunchArgs,
  buildLaunchCommand,
  resolvePiExecutable,
  resolveWorkerExecutable,
  WORKER_RUNTIME_ENV,
} from "./launch-command.js";

export type {
  ConfiguredExtension,
  LaunchArgs,
  LaunchCommand,
  LaunchInputs,
  PiExecutable,
  SlotLaunchInputs,
} from "./launch-command.js";
