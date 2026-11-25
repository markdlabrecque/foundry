/**
 * The Worker Host's diagnostics (PRD §15.2). The host is detached, so its stderr is
 * `logs/host.log`, its only output; every line it writes there is one JSON object carrying the
 * host ID and, where they apply, the factory, slot and launch IDs. Launch commands, arguments
 * and environments are never logged: they can hold credentials and prompts.
 *
 * Worker stderr is not copied into the host log. The host keeps a bounded tail of each launch's
 * stderr and writes it to `logs/launches/<launch-id>.stderr` only when the launch ends
 * unexpectedly, keeping the last few per slot.
 */
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Path, relative to the state root, of the directory holding retained launch stderr. */
export const LAUNCH_LOGS_DIR = join("logs", "launches");

export function launchStderrPath(stateRoot: string, launchId: string): string {
  return join(stateRoot, LAUNCH_LOGS_DIR, `${launchId}.stderr`);
}

/** Bytes of stderr kept in memory per launch. */
export const LAUNCH_STDERR_TAIL_BYTES = 64 * 1024;
/** Retained stderr files per slot. */
export const LAUNCH_STDERR_KEEP_PER_SLOT = 3;

export interface HostLogRefs {
  readonly factoryId?: string;
  readonly slotId?: string;
  readonly launchId?: string;
}

export type HostLogLevel = "info" | "warn" | "error";

/** Writes one structured line to `write` (the host's stderr, which is the host log). */
export function createHostLog(
  hostId: string,
  write: (line: string) => void = (line) => void process.stderr.write(line),
): (level: HostLogLevel, msg: string, refs?: HostLogRefs, detail?: Record<string, string | number | boolean | null>) => void {
  return (level, msg, refs = {}, detail) => {
    const line: Record<string, unknown> = { time: new Date().toISOString(), level, hostId, msg, ...refs };
    if (detail !== undefined) line["detail"] = detail;
    write(`${JSON.stringify(line)}\n`);
  };
}

/** The last `limit` bytes written to it; older bytes are dropped. */
export class StderrTail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number = LAUNCH_STDERR_TAIL_BYTES) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  contents(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

/**
 * Writes retained launch stderr files (0700 directory, 0600 files) and prunes each slot to its
 * newest `keepPerSlot` files. It remembers only files it wrote in this host's lifetime.
 */
export function createLaunchStderrStore(stateRoot: string, keepPerSlot: number = LAUNCH_STDERR_KEEP_PER_SLOT) {
  const retained = new Map<string, string[]>();
  return {
    async retain(factoryId: string, slotId: string, launchId: string, tail: Buffer): Promise<string> {
      const dir = join(stateRoot, LAUNCH_LOGS_DIR);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // The mode above applies only on creation; an older directory is tightened too.
      await chmod(dir, 0o700);
      const path = launchStderrPath(stateRoot, launchId);
      const file = await open(path, "w", 0o600);
      try {
        await file.writeFile(tail);
      } finally {
        await file.close();
      }
      await chmod(path, 0o600);
      const key = JSON.stringify([factoryId, slotId]);
      const paths = retained.get(key) ?? [];
      paths.push(path);
      while (paths.length > keepPerSlot) {
        await unlink(paths.shift()!).catch(() => {});
      }
      retained.set(key, paths);
      return path;
    },
  };
}
