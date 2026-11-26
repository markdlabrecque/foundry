/** A fingerprint of a worktree's files, binding an operator's confirmation to exactly what was inspected. */
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Bound both memory and work; special files are never opened as blocking streams. */
export const fingerprintFiles = async (path: string, names: ReadonlyArray<string>): Promise<string> => {
  const hash = createHash("sha256");
  const limit = 16 * 1024 * 1024;
  let bytes = 0;
  let entries = 0;
  const directories = [path];

  // Git may omit FIFOs/devices from both status and ls-files. Inspect entry types independently.
  while (directories.length > 0) {
    const directory = directories.pop();

    if (directory === undefined) {break;}

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === path && entry.name === ".git") {continue;}

      entries += 1;

      if (entries > 100_000) {throw new Error("filesystem inspection exceeds the 100000-entry safety limit");}

      if (entry.isDirectory()) {directories.push(join(directory, entry.name));}
      else if (!entry.isFile() && !entry.isSymbolicLink()) {throw new Error(`unsupported filesystem entry ${JSON.stringify(join(directory, entry.name))}; preserve and remove it manually`);}
    }
  }

  for (const name of names) {
    const file = join(path, name);
    const stat = await lstat(file);
    hash.update(name).update(String(stat.mode));

    if (stat.isSymbolicLink()) {
      hash.update(await readlink(file));
      continue;
    }

    if (!stat.isFile()) {throw new Error(`unsupported filesystem entry ${JSON.stringify(name)}; preserve and remove it manually`);}

    if (stat.size > limit - bytes) {throw new Error("file inspection exceeds the 16 MiB safety limit; preserve or reduce the files before cleanup");}

    // Recheck the opened inode, with nonblocking/no-follow flags closing the lstat/open race.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);

    try {
      const opened = await handle.stat();

      if (!opened.isFile()) {throw new Error(`unsupported filesystem entry ${JSON.stringify(name)}`);}

      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        if (!Buffer.isBuffer(chunk)) {throw new Error("unexpected file stream encoding");}

        bytes += chunk.length;

        if (bytes > limit) {throw new Error("file inspection exceeds the 16 MiB safety limit");}

        hash.update(chunk);
      }
    } finally {await handle.close();}
  }

  return hash.digest("hex");
};
