import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extDir = fileURLToPath(new URL('.', import.meta.url));

let child: ChildProcess | null = null;
let lastStderr = "";
const port = 3461;

const COST_DIR = joinPath(homedir(), ".pi", "agent", "cost");
const SETTINGS_PATH = joinPath(COST_DIR, "settings.json");
const DEFAULT_THEME_DIR = joinPath(COST_DIR, "themes");

type CostSettings = {
	themes?: { light?: string; dark?: string; dir?: string };
};

function readSettings(): CostSettings {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as CostSettings;
	} catch (e: any) {
		if (e?.code !== "ENOENT") console.warn(`pi-cost: cannot read ${SETTINGS_PATH}: ${e.message}`);
		return {};
	}
}

function buildServerEnv(): NodeJS.ProcessEnv {
	const settings = readSettings();
	const t = settings.themes ?? {};
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
	env.COST_THEME_DIR = process.env.COST_THEME_DIR ?? t.dir ?? DEFAULT_THEME_DIR;
	if (process.env.COST_LIGHT_THEME ?? t.light) {
		env.COST_LIGHT_THEME = process.env.COST_LIGHT_THEME ?? t.light;
	}
	if (process.env.COST_DARK_THEME ?? t.dark) {
		env.COST_DARK_THEME = process.env.COST_DARK_THEME ?? t.dark;
	}
	return env;
}

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

async function waitForPort(p: number, totalMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < totalMs) {
		if (await probePort(p)) return true;
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function findPidsOnPort(p: number): number[] {
	if (process.platform === "win32") {
		const r = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
		if (r.status !== 0) return [];
		const pids = new Set<number>();
		for (const line of r.stdout.split(/\r?\n/)) {
			const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
			if (m && Number(m[1]) === p) pids.add(Number(m[2]));
		}
		return [...pids];
	}
	const r = spawnSync("lsof", ["-tiTCP:" + p, "-sTCP:LISTEN"], { encoding: "utf8" });
	if (r.status !== 0) return [];
	return r.stdout.split(/\s+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
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
	const url = `http://localhost:${port}`;

	type Notify = (m: string, l?: "info" | "error") => void;

	async function startServer(notify: Notify, opts: { silentSuccess?: boolean } = {}): Promise<boolean> {
		if (await probePort(port)) {
			notify(`pi-cost already listening on ${url} — run /cost open to launch it`);
			return true;
		}
		lastStderr = "";
		child = spawn(process.execPath, [serverPath], {
			env: buildServerEnv(),
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
			windowsHide: true,
		});
		child.stderr?.on("data", (b) => { lastStderr += b.toString(); });
		child.on("exit", () => { child = null; });

		if (!(await waitForPort(port))) {
			notify(`pi-cost failed to start.\n${lastStderr.slice(-500) || "(no stderr)"}`, "error");
			return false;
		}
		child.stderr?.removeAllListeners("data");
		child.stderr?.resume();
		child.unref();
		if (!opts.silentSuccess) notify(`pi-cost started → ${url} — run /cost open to launch it`);
		return true;
	}

	async function stopServer(notify: Notify, opts: { silentSuccess?: boolean } = {}): Promise<boolean> {
		if (child) child.kill("SIGINT");
		child = null;

		if (await probePort(port)) {
			const pids = findPidsOnPort(port);
			for (const pid of pids) killPid(pid);
			await new Promise((r) => setTimeout(r, 300));
			if (await probePort(port)) {
				notify(`port ${port} still in use after killing pids ${pids.join(",") || "?"}`, "error");
				return false;
			}
			if (!opts.silentSuccess) {
				notify(`pi-cost stopped (killed orphan pid${pids.length > 1 ? "s" : ""} ${pids.join(",")})`);
			}
			return true;
		}
		if (!opts.silentSuccess) notify("pi-cost stopped");
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
				if (!(await startServer(notify, { silentSuccess: true }))) return;
				notify(`pi-cost restarted → ${url}`);
				return;
			}
			if (sub === "status") {
				const up = await probePort(port);
				const owned = child ? ` (pid ${child.pid})` : " (external)";
				notify(up ? `running on ${url}${owned}` : "not running");
				return;
			}
			if (sub === "open") {
				const { default: open } = await import("open");
				await open(url);
				return;
			}
			notify(`Usage: /cost ${SUBCOMMANDS.join("|")}`, "error");
		},
	});
}
