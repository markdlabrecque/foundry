#!/usr/bin/env node
// FOU-28 compaction probe driver. Runs bare Pi 1.6.0 in RPC mode with a fully
// isolated HOME and PI_CODING_AGENT_DIR under a fresh mktemp directory, a
// credential-free faux model (probe-extension.ts) and no network.
//
// Usage: node run-probe.mjs [outDir]
//   PI_BIN  path to the pinned pi executable (default: the managed 1.6.0 release)
//
// Scenarios:
//   auto    - one prompt whose own size crosses the configured threshold; no tools.
//             Pi's post-run check should compact automatically after the run.
//   midrun  - one prompt that makes the model call `pad` several times; the context
//             crosses the threshold between tool rounds of the same run.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PI_BIN =
	process.env.PI_BIN ??
	join(process.env.HOME, ".pi/agent/install/releases/1.6.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const outDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "fou28-out-")));
mkdirSync(outDir, { recursive: true });

const SETTINGS = {
	enableInstallTelemetry: false,
	compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
};

const SCENARIOS = {
	// Negative control: one ~6250-token prompt crosses the threshold (8000 window -
	// 2000 reserve = 6000), but the session has a single user-message span, so
	// prepareCompaction finds nothing to summarize and Pi silently skips compaction.
	auto_single_span: ["ROUNDS 0 " + "y".repeat(25000)],
	// Configured automatic compaction: two text-only runs (~3000 + ~3500 tokens). The
	// second run crosses the threshold with the first span available to summarize.
	auto: ["ROUNDS 0 " + "y".repeat(12000), "ROUNDS 0 " + "z".repeat(14000)],
	// Each pad result is ~2500 tokens; the threshold is crossed after the second or third.
	midrun: ["ROUNDS 4 SIZE 10000"],
};

// RPC stream events worth keeping (the full stream includes message_update deltas).
const KEEP = new Set([
	"agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
	"tool_execution_start", "tool_execution_end", "compaction_start", "compaction_end", "response",
]);

function runScenario(name, prompts) {
	const root = mkdtempSync(join(tmpdir(), `fou28-${name}-`));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const sessions = join(root, "sessions");
	const work = join(root, "work");
	for (const d of [home, agentDir, sessions, work]) mkdirSync(d, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(SETTINGS, null, 2));
	const extLog = join(outDir, `${name}.extension.jsonl`);
	const rpcLog = join(outDir, `${name}.rpc.jsonl`);
	writeFileSync(extLog, "");
	writeFileSync(rpcLog, "");

	const args = [
		"--mode", "rpc",
		"--no-extensions", "--extension", join(here, "probe-extension.ts"),
		"--provider", "probe", "--model", "tiny",
		"--tools", "pad",
		"--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
		"--no-approve", "--offline",
		"--session-dir", sessions,
	];
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PROBE_LOG: extLog,
	};
	const isJs = PI_BIN.endsWith(".js");
	const child = spawn(isJs ? process.execPath : PI_BIN, isJs ? [PI_BIN, ...args] : args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });

	let rpcSeq = 0;
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	let buf = "";
	const waiters = [];
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (!line.trim()) continue;
			let ev;
			try { ev = JSON.parse(line); } catch { continue; }
			if (KEEP.has(ev.type)) {
				const rec = { seq: rpcSeq++, type: ev.type };
				if (ev.type === "response") Object.assign(rec, { command: ev.command, success: ev.success, data: ev.data, error: ev.error });
				if (ev.type === "compaction_start") rec.reason = ev.reason;
				if (ev.type === "compaction_end") {
					const r = ev.result;
					Object.assign(rec, {
						reason: ev.reason, aborted: ev.aborted, willRetry: ev.willRetry, errorMessage: ev.errorMessage,
						result: r && { tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter, summaryChars: r.summary?.length, details: r.details },
					});
				}
				if (ev.type === "turn_end") rec.stopReason = ev.message?.stopReason;
				if (ev.type.startsWith("tool_execution")) rec.toolCallId = ev.toolCallId;
				if (ev.type === "agent_settled") rec.aborted = ev.aborted;
				writeFileSync(rpcLog, JSON.stringify(rec) + "\n", { flag: "a" });
			}
			for (const w of [...waiters]) if (w.match(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
		}
	});
	const waitFor = (match, ms = 30000) =>
		new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error(`${name}: timeout waiting; stderr:\n${stderr}`)), ms);
			waiters.push({ match, resolve: (e) => { clearTimeout(t); res(e); } });
		});
	const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");

	return (async () => {
		for (const [n, message] of prompts.entries()) {
			const settled = waitFor((e) => e.type === "agent_settled");
			send({ id: `p${n}`, type: "prompt", message });
			await settled;
		}
		const entriesP = waitFor((e) => e.type === "response" && e.command === "get_entries");
		send({ id: "entries", type: "get_entries" });
		const entries = await entriesP;
		child.stdin.end();
		child.kill("SIGTERM");
		const types = (entries.data?.entries ?? entries.data ?? []).map?.((e) => e.type + (e.message ? `:${e.message.role}` : "")) ?? [];
		writeFileSync(join(outDir, `${name}.entries.json`), JSON.stringify(types, null, 2));
		return { name, root, extLog, rpcLog, stderr };
	})();
}

function summarize(name, extLog) {
	const recs = readFileSync(extLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const line = recs
		.filter((r) => r.kind === "event" || r.purpose === "summary")
		.map((r) => {
			if (r.kind === "model_call") return "[summary-call]";
			let s = r.type;
			if (r.reason) s += `(${r.reason}${r.willRetry ? ",retry" : ""})`;
			if (r.type === "turn_end") s += `(${r.stopReason})`;
			if (r.type === "session_compact" || r.type === "session_before_compact") s += r.idle ? "[idle]" : "[busy]";
			return s;
		});
	const compacts = recs.filter((r) => r.type === "session_compact");
	return { name, sessionCompactCount: compacts.length, reasons: compacts.map((c) => c.reason), order: line };
}

const results = [];
for (const [name, prompts] of Object.entries(SCENARIOS)) {
	const r = await runScenario(name, prompts);
	results.push(summarize(name, r.extLog));
}
const report = { piBin: PI_BIN, node: process.version, outDir, settings: SETTINGS, results };
writeFileSync(join(outDir, "summary.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
