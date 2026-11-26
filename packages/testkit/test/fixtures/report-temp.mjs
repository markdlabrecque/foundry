// Tiny subprocess environment witness; not a Pi replacement in gate evidence.
import { tmpdir } from "node:os";

process.stdout.write(`${JSON.stringify({ type: "temp", path: tmpdir() })}\n`);

process.stdin.resume();
