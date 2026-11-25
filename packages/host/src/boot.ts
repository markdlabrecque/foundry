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
    return execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
  }
  throw new Error(`no boot identifier source for platform ${process.platform}`);
}
