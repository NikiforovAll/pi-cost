import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extDir = fileURLToPath(new URL('.', import.meta.url));
const requireLib = createRequire(import.meta.url);
const parsers = requireLib("../lib/pi-parsers-cost.js");
const { readServerRecord, isAlive } = requireLib("../lib/cost-dir.js");

let child: ChildProcess | null = null;
let lastStderr = "";
const PREFERRED_PORT = 5461;

// The server follows the same agent dir as this pi (PI_CODING_AGENT_DIR, else ~/.pi/agent), so a
// dev pi and the main pi each get their own dashboard. The server reads theme settings itself.
const AGENT_DIR: string = parsers.getAgentDir();
const COST_DIR: string = parsers.getCostDir();

type ServerRecord = { pid: number; port: number };

const SUBCOMMANDS = ["start", "stop", "restart", "status", "open"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

function probePort(p: number, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection({ port: p, host: "127.0.0.1" });
		const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
	});
}

async function runningServer(): Promise<ServerRecord | null> {
	const rec: ServerRecord | null = readServerRecord(COST_DIR);
	return rec && (await probePort(rec.port)) ? rec : null;
}

async function waitForServer(pid: number, totalMs = 8000): Promise<ServerRecord | null> {
	const start = Date.now();
	while (Date.now() - start < totalMs) {
		const rec = await runningServer();
		if (rec && rec.pid === pid) return rec;
		await new Promise((r) => setTimeout(r, 150));
	}
	return null;
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function killPid(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
	} else {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
}

export default function costExtension(pi: ExtensionAPI) {
	const serverPath = resolvePath(extDir, "..", "server.js");
	const urlOf = (rec: ServerRecord) => `http://localhost:${rec.port}`;

	type Notify = (m: string, l?: "info" | "error") => void;

	async function startServer(notify: Notify, opts: { silentSuccess?: boolean } = {}): Promise<ServerRecord | null> {
		const existing = await runningServer();
		if (existing) {
			if (!opts.silentSuccess) notify(`pi-cost already listening on ${urlOf(existing)} — run /cost open to launch it`);
			return existing;
		}
		lastStderr = "";
		// No --port: the server takes PORT, and a random port when that one is in use.
		child = spawn(process.execPath, [serverPath, "--no-open"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, PORT: String(PREFERRED_PORT) },
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
			windowsHide: true,
		});
		child.stderr?.on("data", (b) => { lastStderr += b.toString(); });
		child.on("exit", () => { child = null; });

		const rec = child.pid ? await waitForServer(child.pid) : null;
		if (!rec || !child) {
			notify(`pi-cost failed to start.\n${lastStderr.slice(-500) || "(no stderr)"}`, "error");
			return null;
		}
		child.stderr?.removeAllListeners("data");
		child.stderr?.resume();
		child.unref();
		if (!opts.silentSuccess) notify(`pi-cost started → ${urlOf(rec)} — run /cost open to launch it`);
		return rec;
	}

	async function stopServer(notify: Notify, opts: { silentSuccess?: boolean } = {}): Promise<boolean> {
		const rec = await runningServer();
		if (child) child.kill("SIGINT");
		child = null;
		if (!rec) {
			if (!opts.silentSuccess) notify("pi-cost stopped");
			return true;
		}
		await new Promise((r) => setTimeout(r, 300));
		if (isAlive(rec.pid)) killPid(rec.pid);
		await new Promise((r) => setTimeout(r, 300));
		if (await probePort(rec.port)) {
			notify(`port ${rec.port} still in use after killing pid ${rec.pid}`, "error");
			return false;
		}
		if (!opts.silentSuccess) notify(`pi-cost stopped (pid ${rec.pid})`);
		return true;
	}

	pi.registerCommand("cost", {
		description: "pi-cost dashboard: start | stop | restart | status | open",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const tokens = splitArgs(args);
			const sub = (tokens[0] || "start") as Sub;
			const notify = (m: string, l: "info" | "error" = "info") => ctx.ui.notify(m, l);

			if (sub === "start") { await startServer(notify); return; }
			if (sub === "stop") { await stopServer(notify); return; }
			if (sub === "restart") {
				if (!(await stopServer(notify, { silentSuccess: true }))) return;
				const rec = await startServer(notify, { silentSuccess: true });
				if (rec) notify(`pi-cost restarted → ${urlOf(rec)}`);
				return;
			}
			if (sub === "status") {
				const rec = await runningServer();
				notify(rec ? `running on ${urlOf(rec)} (pid ${rec.pid}, agent dir ${AGENT_DIR})` : "not running");
				return;
			}
			if (sub === "open") {
				const rec = (await runningServer()) ?? (await startServer(notify, { silentSuccess: true }));
				if (!rec) return;
				const { default: open } = await import("open");
				await open(urlOf(rec));
				return;
			}
			notify(`Usage: /cost ${SUBCOMMANDS.join("|")}`, "error");
		},
	});
}
