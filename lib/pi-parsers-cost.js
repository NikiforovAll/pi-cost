'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const ENV_SESSION_DIR = 'PI_CODING_AGENT_SESSION_DIR';

// libuv aborts on a watched Windows path that holds an 8.3 short name (NIKIFO~1), because events
// come back with the long name. Resolve the deepest existing ancestor and re-append the rest.
function longPath(target) {
  let cur = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const pathKeys = new Map();
const PATH_KEYS_MAX = 20_000;

// Comparison key for a file path. pi records paths as it was given them, which may hold 8.3 short
// names (NIKIFO~1) while listings are long; a short name always has a `~`, so only those hit the disk.
function pathKey(p) {
  if (!p) return '';
  let key = pathKeys.get(p);
  if (key !== undefined) return key;
  key = p.includes('~') ? longPath(p) : path.resolve(p);
  if (process.platform === 'win32') key = key.toLowerCase();
  if (pathKeys.size >= PATH_KEYS_MAX) pathKeys.clear();
  pathKeys.set(p, key);
  return key;
}

// pi's normalizePath: Git Bash / Cygwin / WSL drive paths on Windows, then ~.
function normalizePiPath(p) {
  let s = String(p).trim();
  if (process.platform === 'win32' && s.startsWith('/') && !s.startsWith('//') && !s.includes('\\')) {
    const m = s.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) s = `${m[1].toUpperCase()}:\\${(m[2] || '').replaceAll('/', '\\')}`;
  }
  if (s === '~') return os.homedir();
  if (/^~[\\/]/.test(s)) return path.join(os.homedir(), s.slice(2));
  return s;
}

// Same rule as pi's getAgentDir: PI_CODING_AGENT_DIR, else <PI_DIR>/agent with PI_DIR defaulting to ~/.pi.
function rawAgentDir(env) {
  if (env.PI_CODING_AGENT_DIR) return normalizePiPath(env.PI_CODING_AGENT_DIR);
  return path.join(env.PI_DIR || path.join(os.homedir(), '.pi'), 'agent');
}

function readSettingsSessionDir(agentDir) {
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'))?.sessionDir;
    return typeof dir === 'string' && dir.trim() ? normalizePiPath(dir) : null;
  } catch {
    return null;
  }
}

// pi's precedence: --session-dir, then PI_CODING_AGENT_SESSION_DIR, then settings.sessionDir. A
// custom dir is flat (<dir>/<ts>_<id>.jsonl). The default nested dir stays in the list, because
// sessions written before a custom dir was set are still there. pi resolves a relative settings
// dir against the cwd of each pi run, which pi-cost does not know, so only an absolute one counts.
function resolveRoots({ env = process.env, sessionDir = null, cwd = process.cwd() } = {}) {
  const agentDir = longPath(rawAgentDir(env));
  const nested = { dir: longPath(path.join(agentDir, 'sessions')), flat: false };
  const forced = sessionDir || env[ENV_SESSION_DIR];
  const fromSettings = forced ? null : readSettingsSessionDir(agentDir);
  const custom = forced ? path.resolve(cwd, normalizePiPath(forced))
    : fromSettings && path.isAbsolute(fromSettings) ? fromSettings : null;
  const roots = [];
  if (custom) {
    const dir = longPath(custom);
    if (pathKey(dir) !== pathKey(nested.dir)) roots.push({ dir, flat: true });
  }
  roots.push(nested);
  return { agentDir, roots };
}

let config = resolveRoots();

function configure(opts) {
  config = resolveRoots(opts);
  sessionCache.clear();
  headerCache.clear();
}

function getPiDir() { return path.dirname(config.agentDir); }
function getAgentDir() { return config.agentDir; }
function getCostDir() { return path.join(config.agentDir, 'cost'); }
function getSessionsDir() { return config.roots[0].dir; }
function getSessionRoots() { return config.roots; }

function encodeProjectDir(cwd) {
  return `--${String(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// Lossy: a dash inside a folder name reads back as a separator. Prefer the header cwd.
function decodeProjectDir(name) {
  let s = name;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  const m = s.match(/^([A-Za-z])--(.+)$/);
  if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
  return `/${s.replace(/-/g, '/')}`;
}

const HEADER_MAX = 64 * 1024;
const headerCache = new Map();

async function readSessionHeader(file) {
  if (headerCache.has(file)) return headerCache.get(file);
  let header = null;
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(HEADER_MAX);
    const { bytesRead } = await fh.read(buf, 0, HEADER_MAX, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    const obj = JSON.parse(buf.toString('utf8', 0, nl === -1 ? bytesRead : nl));
    if (obj && obj.type === 'session' && obj.id) header = obj;
  } catch {
    header = null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  if (header) headerCache.set(file, header);
  return header;
}

async function readdirSafe(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

async function statJsonls(dir) {
  const entries = await readdirSafe(dir);
  const out = await Promise.all(entries.filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map(async (f) => {
    const file = path.join(dir, f.name);
    try {
      const s = await fs.promises.stat(file);
      return { file, mtime: s.mtime, mtimeMs: s.mtimeMs, size: s.size };
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

// In a flat dir the project comes from the header cwd; in the nested dir from the folder name.
async function withProject(f, projectDirName) {
  if (projectDirName) return { ...f, projectDir: projectDirName, cwd: decodeProjectDir(projectDirName) };
  const header = await readSessionHeader(f.file);
  if (!header || !header.cwd) return null;
  return { ...f, projectDir: encodeProjectDir(header.cwd), cwd: header.cwd };
}

async function listSessionFiles() {
  const perRoot = await Promise.all(config.roots.map(async (root) => {
    if (root.flat) {
      const files = await statJsonls(root.dir);
      return Promise.all(files.map((f) => withProject(f, null)));
    }
    const projects = (await readdirSafe(root.dir)).filter((d) => d.isDirectory());
    const perProject = await Promise.all(projects.map(async (d) => {
      const files = await statJsonls(path.join(root.dir, d.name));
      return Promise.all(files.map((f) => withProject(f, d.name)));
    }));
    return perProject.flat();
  }));
  return perRoot.flat().filter(Boolean);
}

async function subdirs(dir) {
  return (await readdirSafe(dir)).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
}

// pi-subagents writes <dir of parent jsonl>/<parent basename>/<runId>/<attempt>/session.jsonl.
// Their cost is already in the parent's `subagent` toolResult; they are listed so a run can be opened.
async function nestedUnder(parentsDir, projectDirName) {
  const out = [];
  for (const parent of await subdirs(parentsDir)) {
    for (const run of await subdirs(parent)) {
      for (const attempt of await subdirs(run)) {
        const file = path.join(attempt, 'session.jsonl');
        try {
          const s = await fs.promises.stat(file);
          const base = { file, parentDirName: path.basename(parent), runId: path.basename(run), attempt: path.basename(attempt), mtime: s.mtime, mtimeMs: s.mtimeMs, size: s.size };
          const withProj = await withProject(base, projectDirName);
          if (withProj) out.push(withProj);
        } catch {}
      }
    }
  }
  return out;
}

async function listNestedSubagentFiles() {
  const perRoot = await Promise.all(config.roots.map(async (root) => {
    if (root.flat) return nestedUnder(root.dir, null);
    const projects = await subdirs(root.dir);
    return (await Promise.all(projects.map((p) => nestedUnder(p, path.basename(p))))).flat();
  }));
  return perRoot.flat();
}

async function readJsonlLines(file) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (l) => { if (l.trim()) lines.push(l); });
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function readSessionEntriesUncached(file) {
  const lines = await readJsonlLines(file);
  const entries = [];
  for (const l of lines) {
    const e = parseLine(l);
    if (e) entries.push(e);
  }
  return entries;
}

const SESSION_CACHE_MAX = 200;
const sessionCache = new Map();

function cachePut(file, entry) {
  if (sessionCache.has(file)) sessionCache.delete(file);
  sessionCache.set(file, entry);
  while (sessionCache.size > SESSION_CACHE_MAX) {
    sessionCache.delete(sessionCache.keys().next().value);
  }
}

function basenameWithoutExt(file) { return path.basename(file, '.jsonl'); }

function slugFromFile(file) {
  const base = basenameWithoutExt(file);
  const idx = base.indexOf('_');
  return idx >= 0 ? base.slice(idx + 1) : base;
}

// Aggregate per-session totals. Mirrors pi-kanban's summarize() but trimmed to
// the fields we need for cost reporting.
function summarize(entries) {
  let sessionEntry = null;
  let lastTimestamp = null;
  let firstTimestamp = null;
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let userCount = 0;
  let assistantCount = 0;
  let messageCount = 0;
  let provider = null;
  let model = null;
  let customTitle = null;
  let firstUserText = null;
  let parentSession = null;

  for (const e of entries) {
    if (e.type === 'session') {
      sessionEntry = e;
      if (e.parentSession) parentSession = e.parentSession;
      if (!firstTimestamp) firstTimestamp = e.timestamp || null;
    } else if (e.type === 'session_info') {
      if (typeof e.name === 'string' && e.name.trim()) customTitle = e.name.trim();
    } else if (e.type === 'model_change') {
      provider = e.provider || provider;
      model = e.modelId || model;
    } else if (e.type === 'message') {
      messageCount++;
      if (!firstTimestamp) firstTimestamp = e.timestamp || null;
      lastTimestamp = e.timestamp || lastTimestamp;
      const m = e.message || {};
      if (m.role === 'user') {
        userCount++;
        if (!firstUserText) {
          const c = m.content;
          const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x && x.type === 'text')?.text : null;
          if (txt) firstUserText = txt;
        }
      } else if (m.role === 'assistant') {
        assistantCount++;
        const u = m.usage;
        if (u) {
          totalInput += u.input || 0;
          totalOutput += u.output || 0;
          totalCacheRead += u.cacheRead || 0;
          totalCacheWrite += u.cacheWrite || 0;
          totalCost += (u.cost && u.cost.total) || 0;
        }
        if (m.provider) provider = m.provider;
        if (m.model) model = m.model;
      }
    }
  }

  return {
    sessionEntry,
    firstTimestamp,
    lastTimestamp,
    totalCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    userCount,
    assistantCount,
    messageCount,
    provider,
    model,
    customTitle,
    firstUserText,
    parentSession,
  };
}

async function getCachedSession(file, knownStat = null) {
  const stat = knownStat || await fs.promises.stat(file);
  const cached = sessionCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cachePut(file, cached);
    return cached;
  }
  const entries = await readSessionEntriesUncached(file);
  const summary = summarize(entries);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, entries, summary };
  cachePut(file, entry);
  return entry;
}

function invalidateSessionCache(file) {
  if (file) sessionCache.delete(file);
  else sessionCache.clear();
}

function toolNames(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'toolCall' && b.name).map((b) => b.name);
}

// Yields one usage row per assistant message and per compaction that recorded its summarizer usage.
// A compaction has no model of its own, so it takes the model in effect at that point.
function* enumerateMessageUsages(entries) {
  let provider = null;
  let model = null;
  for (const e of entries) {
    if (e.type === 'model_change') {
      provider = e.provider || provider;
      model = e.modelId || model;
      continue;
    }
    if (e.type === 'compaction') {
      if (!e.usage) continue;
      yield {
        ts: e.timestamp || null,
        provider,
        model,
        usage: e.usage,
        messageId: e.id || null,
        compaction: { tokensBefore: e.tokensBefore || 0, fromHook: !!e.fromHook },
      };
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message || {};
    if (m.role !== 'assistant') continue;
    if (m.provider) provider = m.provider;
    if (m.model) model = m.model;
    const u = m.usage;
    if (!u) continue;
    yield {
      ts: e.timestamp || null,
      provider: m.provider || provider,
      model: m.model || model,
      usage: u,
      messageId: e.id || null,
      tools: toolNames(m.content),
      durationMs: m.durationMs || null,
    };
  }
}

// Compactions without recorded usage still matter to the timeline, so they are listed apart.
function* enumerateCompactions(entries) {
  for (const e of entries) {
    if (e.type !== 'compaction') continue;
    yield { ts: e.timestamp || null, tokensBefore: e.tokensBefore || 0, fromHook: !!e.fromHook, hasUsage: !!e.usage, id: e.id || null };
  }
}

// Yields { ts, agent, task, model, usage, runId, jsonlPath } per subagent run.
// pi records subagent invocations as `subagent` tool results in the parent's
// JSONL; each `details.results[]` entry is one run with its own usage block.
function* enumerateSubagentRuns(entries) {
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const m = e.message;
    if (!m || m.role !== 'toolResult' || m.toolName !== 'subagent') continue;
    const results = m.details && Array.isArray(m.details.results) ? m.details.results : [];
    for (const r of results) {
      if (!r || !r.usage) continue;
      yield {
        ts: e.timestamp || m.timestamp || null,
        agent: r.agent || null,
        task: r.task || null,
        model: r.model || null,
        usage: r.usage,
        runId: m.details?.runId || null,
        jsonlPath: r.sessionFile || r.artifactPaths?.jsonlPath || null,
        turns: r.usage.turns || null,
        exitCode: r.exitCode ?? null,
      };
    }
  }
}

module.exports = {
  ENV_SESSION_DIR,
  resolveRoots,
  configure,
  longPath,
  pathKey,
  normalizePiPath,
  getPiDir,
  getAgentDir,
  getCostDir,
  getSessionsDir,
  getSessionRoots,
  encodeProjectDir,
  decodeProjectDir,
  readSessionHeader,
  listSessionFiles,
  listNestedSubagentFiles,
  readSessionEntriesUncached,
  summarize,
  getCachedSession,
  invalidateSessionCache,
  enumerateMessageUsages,
  enumerateCompactions,
  enumerateSubagentRuns,
  slugFromFile,
};
