/** The machine boot identifier recorded with every launch (PRD §3.2, §10.2). */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Returns a string that is equal across calls within one machine boot and
 * differs after a reboot: Linux's kernel boot_id, or macOS's kern.boottime.
 */
export function readBootId(): string {
  if (process.platform === "linux") {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  }

  if (process.platform === "darwin") {
    // e.g. "{ sec = 1700000000, usec = 123456 } Tue Nov 14 ..."; the date part depends on TZ.
    const raw = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(raw);

    if (match === null) {throw new Error(`cannot parse kern.boottime: ${raw.trim()}`);}

    return `${match[1]}.${match[2]}`;
  }

  throw new Error(`no boot identifier source for platform ${process.platform}`);
}
