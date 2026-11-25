/**
 * Channel diagnostics for the daemon log (PRD §15.2). Accepted, refused and lost channels are
 * logged at `info`; every frame is logged at `debug` by its type only, never its contents, so
 * message bodies stay out of the log.
 */
import type { DaemonLogger } from "../log.js";
import type { ChannelEvents, ClaimedSlot } from "./server.js";

const refs = (slot: ClaimedSlot) => ({ factoryId: slot.factoryId, slotId: slot.slotId, launchId: slot.launchId });

export const channelLogEvents = (logger: DaemonLogger): Required<ChannelEvents> => ({
  onAccepted: (slot, hello) =>
    logger.info("channel accepted", { ...refs(slot), detail: { mode: hello.mode, tools: hello.tools.length } }),
  onRejected: (reason) =>
    logger.info("channel hello refused", { detail: { kind: reason.kind, code: reason.code } }),
  onChannelLost: (slot, cause) => logger.info("channel lost", { ...refs(slot), detail: { cause } }),
  onFrame: (slot, frame) => logger.debug("channel frame", { ...refs(slot), detail: { frame: frame.type } }),
});
