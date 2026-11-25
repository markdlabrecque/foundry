/** The Worker Host: owns worker launches and resolves the pinned pi binary. */
export const packageName = "@foundry/host" as const;

export {
  HOST_CONTROL_VERSION,
  HOST_SOCKET_NAME,
  hostSocketPath,
  type HostIdentity,
  type HostRequest,
  type HostResponse,
} from "./control.js";
export { serveHost, type RunningHost } from "./server.js";
export {
  HOST_LOG_NAME,
  connectHost,
  startHost,
  type ConnectHostOptions,
  type HostConnection,
  type StartHostOptions,
} from "./client.js";
