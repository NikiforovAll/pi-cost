'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const PI_DIR = process.env.PI_DIR || path.join(os.homedir(), '.pi');
const SESSIONS_DIR = path.join(PI_DIR, 'agent', 'sessions');

function getPiDir() { return PI_DIR; }
function getSessionsDir() { return SESSIONS_DIR; }

// "--C--Users-nikiforovall-dev-pi--" -> "C:\Users\nikiforovall\dev\pi"
function decodeProjectDir(name) {
  let s = name;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  const m = s.match(/^([A-Za-z])--(.+)$/);
  if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
  return s.replace(/-/g, path.sep);
}

async function listSessionFiles() {
  let projDirs;
  try { projDirs = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true }); }
  catch { return []; }
  const projects = projDirs.filter((d) => d.isDirectory());
  const perProject = await Promise.all(projects.map(async (d) => {
    const projDir = d.name;
    const projPath = path.join(SESSIONS_DIR, projDir);
    let files;
    try { files = await fs.promises.readdir(projPath, { withFileTypes: true }); }
    catch { return []; }
    const jsonls = files.filter((f) => f.isFile() && f.name.endsWith('.jsonl'));
    const stats = await Promise.all(jsonls.map(async (f) => {
      const full = path.join(projPath, f.name);
      try {
        const s = await fs.promises.stat(full);
        return { file: full, projectDir: projDir, cwd: decodeProjectDir(projDir), mtime: s.mtime, mtimeMs: s.mtimeMs, size: s.size };
      } catch { return null; }
    }));
    return stats.filter(Boolean);
  }));
  return perProject.flat();
}

// Nested subagent JSONLs live under <projectDir>/<parentSessionId>/<runId>/run-N/session.jsonl.
// Cost is already accounted for inline in the parent's `subagent` toolResult; we list
// them separately so the UI can drill into a specific run.
async function listNestedSubagentFiles() {
  let projDirs;
  try { projDirs = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  await Promise.all(projDirs.filter((d) => d.isDirectory()).map(async (proj) => {
    const projPath = path.join(SESSIONS_DIR, proj.name);
    let parentDirs;
    try { parentDirs = await fs.promises.readdir(projPath, { withFileTypes: true }); }
    catch { return; }
    await Promise.all(parentDirs.filter((d) => d.isDirectory()).map(async (parent) => {
      const parentPath = path.join(projPath, parent.name);
      let runDirs;
      try { runDirs = await fs.promises.readdir(parentPath, { withFileTypes: true }); }
      catch { return; }
      await Promise.all(runDirs.filter((d) => d.isDirectory()).map(async (run) => {
        const runPath = path.join(parentPath, run.name);
        let attempts;
        try { attempts = await fs.promises.readdir(runPath, { withFileTypes: true }); }
        catch { return; }
        await Promise.all(attempts.filter((d) => d.isDirectory()).map(async (attempt) => {
          const file = path.join(runPath, attempt.name, 'session.jsonl');
          try {
            const s = await fs.promises.stat(file);
            out.push({
              file,
              projectDir: proj.name,
              parentDirName: parent.name,
              runId: run.name,
              attempt: attempt.name,
              mtime: s.mtime, mtimeMs: s.mtimeMs, size: s.size,
            });
          } catch {}
        }));
      }));
    }));
  }));
  return out;
}

async function readJsonlLines(file) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (l) => { if (l.trim()) lines.push(l); });
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
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
          const txt = Array.isArray(c) ? c.find((x) => x && x.type === 'text')?.text : null;
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

// Yields { ts, provider, model, usage, messageId } per assistant message with usage.
function* enumerateMessageUsages(entries) {
  let provider = null;
  let model = null;
  for (const e of entries) {
    if (e.type === 'model_change') {
      provider = e.provider || provider;
      model = e.modelId || model;
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message || {};
    if (m.role !== 'assistant') continue;
    const u = m.usage;
    if (!u) continue;
    yield {
      ts: e.timestamp || null,
      provider: m.provider || provider,
      model: m.model || model,
      usage: u,
      messageId: e.id || null,
    };
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
  getPiDir,
  getSessionsDir,
  decodeProjectDir,
  listSessionFiles,
  listNestedSubagentFiles,
  readSessionEntriesUncached,
  summarize,
  getCachedSession,
  invalidateSessionCache,
  enumerateMessageUsages,
  enumerateSubagentRuns,
  slugFromFile,
};
