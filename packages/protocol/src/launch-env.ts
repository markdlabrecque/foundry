/**
 * How a worker learns who it is and where to dial (PRD §3.2): environment variables set on each
 * launch. Defined once here, because the Worker Host and the daemon set them and the Foundry
 * extension reads them.
 */
import { join } from "node:path";

/** Environment variables carrying launch identity to the Foundry extension, set by the Worker Host. */
export const LAUNCH_ENV = {
  factoryId: "FOUNDRY_FACTORY_ID",
  /** Also the slot marker: its presence means "running inside a worker". */
  slotId: "FOUNDRY_SLOT",
  launchId: "FOUNDRY_LAUNCH_ID",
} as const;

/** Environment variable naming the instance's channel socket, set by the daemon on each launch. */
export const CHANNEL_SOCKET_ENV = "FOUNDRY_CHANNEL_SOCKET";

/** File name of the worker channel socket inside the state root, beside the management socket. */
export const CHANNEL_SOCKET_NAME = "channel.sock";

/** The channel socket of the instance whose state root is `stateRoot`. */
export const channelSocketPath = (stateRoot: string): string => join(stateRoot, CHANNEL_SOCKET_NAME);
