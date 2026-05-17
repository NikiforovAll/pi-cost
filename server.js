#!/usr/bin/env node
'use strict';

const http = require('node:http');
const express = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');

const parsers = require('./lib/pi-parsers-cost');
const pricing = require('./lib/pi-pricing');

// #region CLI_ARGS

function getArg(name) {
  const eqIdx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx === -1) return null;
  const arg = process.argv[eqIdx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return process.argv[eqIdx + 1] || null;
}

const PORT = parseInt(getArg('port') || process.env.PORT || '5461', 10);

// #endregion

// #region THEMES

const BUILTIN_THEME_DIR = path.join(__dirname, 'themes');
const COST_DIR = path.join(os.homedir(), '.pi', 'agent', 'cost');
const SETTINGS_PATH = path.join(COST_DIR, 'settings.json');

function readSettings() {
  try {
    const raw = require('node:fs').readFileSync(SETTINGS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`themes: cannot read ${SETTINGS_PATH}: ${e.message}`);
    return {};
  }
}

const SETTINGS = readSettings();
const SETTINGS_THEMES = (SETTINGS && SETTINGS.themes) || {};

const USER_THEME_DIR = process.env.COST_THEME_DIR
  || SETTINGS_THEMES.dir
  || path.join(COST_DIR, 'themes');
const LIGHT_THEME_ID = process.env.COST_LIGHT_THEME || SETTINGS_THEMES.light || 'pi-light';
const DARK_THEME_ID = process.env.COST_DARK_THEME || SETTINGS_THEMES.dark || 'pi-dark';

const REQUIRED_COLOR_KEYS = [
  'bgDeep', 'bgSurface', 'bgElevated', 'bgHover',
  'border',
  'textPrimary', 'textSecondary', 'textTertiary', 'textMuted',
  'accent', 'accentText',
  'success', 'warning', 'error',
];

const themes = new Map();

async function loadThemesFromDir(dir, builtin) {
  let entries;
  try { entries = await fsp.readdir(dir); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`themes: cannot read ${dir}: ${e.message}`);
    return;
  }
  const jsons = entries.filter((f) => f.toLowerCase().endsWith('.json'));
  await Promise.all(jsons.map(async (f) => {
    const full = path.join(dir, f);
    const id = f.replace(/\.json$/i, '');
    try {
      const raw = await fsp.readFile(full, 'utf8');
      const obj = JSON.parse(raw);
      if (obj.mode !== 'light' && obj.mode !== 'dark') {
        console.warn(`themes: skip ${full}: invalid mode`); return;
      }
      const colors = obj.colors || {};
      const missing = REQUIRED_COLOR_KEYS.filter((k) => typeof colors[k] !== 'string');
      if (missing.length) {
        console.warn(`themes: skip ${full}: missing colors ${missing.join(',')}`); return;
      }
      themes.set(id, {
        id,
        name: obj.name || id,
        displayName: obj.displayName || obj.name || id,
        mode: obj.mode,
        colors,
        builtin,
      });
    } catch (e) {
      console.warn(`themes: skip ${full}: ${e.message}`);
    }
  }));
}

async function loadAllThemes() {
  themes.clear();
  await loadThemesFromDir(BUILTIN_THEME_DIR, true);
  await loadThemesFromDir(USER_THEME_DIR, false);
}

function resolveActiveTheme(mode) {
  const requestedId = mode === 'light' ? LIGHT_THEME_ID : DARK_THEME_ID;
  const fallbackId = mode === 'light' ? 'pi-light' : 'pi-dark';
  return themes.get(requestedId) || themes.get(fallbackId) || null;
}

// #endregion

// #region CACHE

const CACHE_TTL = 30_000;
let dataCache = new Map();

function cacheGet(key) {
  const hit = dataCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { dataCache.delete(key); return null; }
  return hit.payload;
}
function cacheSet(key, payload) { dataCache.set(key, { ts: Date.now(), payload }); }
function cacheClear() { dataCache.clear(); }

// #endregion

// #region AGGREGATION

function rangeToCutoff(range, now) {
  if (range === 'today') {
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d;
  }
  if (!range || !Number.isFinite(range)) return null;
  const d = new Date(now); d.setDate(d.getDate() - range); return d;
}

function normalizePath(p) {
  return p ? String(p).replace(/\//g, '\\').toLowerCase() : '';
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fillDaily(daily, start, end) {
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = localDateStr(d);
    out.push({ date: ds, cost: daily[ds]?.cost || 0 });
  }
  return out;
}

// path(lowercased) → uuid. Populated lazily; refreshed when the underlying
// directory listing changes. Used to turn a subagent run's `sessionFile` path
// into a clickable session id.
let nestedIndexPromise = null;
function loadNestedIndex(force = false) {
  if (!force && nestedIndexPromise) return nestedIndexPromise;
  nestedIndexPromise = (async () => {
    const files = await parsers.listNestedSubagentFiles();
    const map = new Map();
    await Promise.all(files.map(async (f) => {
      try {
        const { entries } = await parsers.getCachedSession(f.file, { mtimeMs: f.mtimeMs, size: f.size });
        const sess = entries.find((e) => e.type === 'session');
        if (sess && sess.id) map.set(normalizePath(f.file), { id: sess.id, ...f });
      } catch {}
    }));
    return map;
  })();
  return nestedIndexPromise;
}

async function findSessionFileById(id) {
  const top = await parsers.listSessionFiles();
  for (const f of top) if (f.file.includes(id)) return f;
  const nested = await loadNestedIndex();
  for (const entry of nested.values()) {
    if (entry.id === id) return { file: entry.file, projectDir: entry.projectDir, cwd: parsers.decodeProjectDir(entry.projectDir), mtime: entry.mtime, mtimeMs: entry.mtimeMs, size: entry.size };
  }
  for (const f of top) {
    try {
      const { entries } = await parsers.getCachedSession(f.file, { mtimeMs: f.mtimeMs, size: f.size });
      const sess = entries.find((e) => e.type === 'session');
      if (sess && sess.id === id) return f;
    } catch {}
  }
  return null;
}

async function buildSessionDetail(meta, pricingMap) {
  const cached = await parsers.getCachedSession(meta.file, { mtimeMs: meta.mtimeMs, size: meta.size });
  const entries = cached.entries;
  const summary = cached.summary;
  const messages = [];
  const seen = new Set();
  let cumulative = 0;
  let totalCost = 0;
  const modelsSeen = new Set();
  let sourceCounts = { jsonl: 0, pricing: 0, none: 0 };

  for (const u of parsers.enumerateMessageUsages(entries)) {
    if (u.messageId) {
      if (seen.has(u.messageId)) continue;
      seen.add(u.messageId);
    }
    const est = pricing.estimate(pricingMap, u.provider, u.model, u.usage);
    cumulative += est.cost;
    totalCost += est.cost;
    sourceCounts[est.source]++;
    if (u.model) modelsSeen.add(u.model);
    messages.push({
      ts: u.ts,
      provider: u.provider,
      model: u.model,
      input: u.usage.input || 0,
      output: u.usage.output || 0,
      cacheRead: u.usage.cacheRead || 0,
      cacheWrite: u.usage.cacheWrite || 0,
      cost: est.cost,
      cumulativeCost: cumulative,
      costSource: est.source,
      modelKey: est.modelKey,
    });
  }

  // Inline subagent runs (pi >= v3 records each run inside the parent's
  // JSONL as a `subagent` toolResult). Merged into `messages` as pseudo-rows
  // so the UI shows a single unified timeline. Subscription providers report
  // usage.cost = 0, so we always estimate.
  const stripSuffix = (m) => (m ? String(m).replace(/:(low|medium|high)$/, '') : m);
  let inlineSubCost = 0;
  let inlineSubTokens = 0;
  let inlineSubCount = 0;
  const nestedIndex = await loadNestedIndex();
  for (const r of parsers.enumerateSubagentRuns(entries)) {
    const model = stripSuffix(r.model);
    const est = pricing.estimate(pricingMap, null, model, r.usage);
    const nestedEntry = r.jsonlPath ? nestedIndex.get(normalizePath(r.jsonlPath)) : null;
    const subagentSessionId = nestedEntry ? nestedEntry.id : null;
    inlineSubCost += est.cost;
    const tk = (r.usage.input || 0) + (r.usage.output || 0)
             + (r.usage.cacheRead || 0) + (r.usage.cacheWrite || 0);
    inlineSubTokens += tk;
    inlineSubCount++;
    sourceCounts[est.source]++;
    if (model) modelsSeen.add(model);
    messages.push({
      ts: r.ts,
      provider: null,
      model,
      input: r.usage.input || 0,
      output: r.usage.output || 0,
      cacheRead: r.usage.cacheRead || 0,
      cacheWrite: r.usage.cacheWrite || 0,
      cost: est.cost,
      cumulativeCost: 0, // recomputed below after sort
      costSource: est.source,
      modelKey: est.modelKey,
      agent: r.agent,
      task: r.task,
      subagentSessionId,
      turns: r.turns,
    });
  }

  // Reorder by timestamp and recompute cumulative cost so subagent runs slot
  // into the timeline between assistant messages.
  messages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  let cum = 0;
  for (const m of messages) { cum += m.cost; m.cumulativeCost = cum; }
  totalCost += inlineSubCost;

  return {
    id: (summary.sessionEntry && summary.sessionEntry.id) || parsers.slugFromFile(meta.file),
    parentSession: summary.parentSession,
    inlineSubCost,
    inlineSubTokens,
    inlineSubCount,
    customTitle: summary.customTitle,
    firstUserText: summary.firstUserText,
    provider: summary.provider,
    model: summary.model,
    models: [...modelsSeen],
    totalCost,
    totalInput: summary.totalInput,
    totalOutput: summary.totalOutput,
    totalCacheRead: summary.totalCacheRead,
    totalCacheWrite: summary.totalCacheWrite,
    totalTokens: summary.totalTokens,
    messageCount: messages.length,
    firstTimestamp: summary.firstTimestamp,
    lastTimestamp: summary.lastTimestamp || meta.mtime.toISOString(),
    sourceCounts,
    messages,
    projectDir: meta.projectDir,
    cwd: (summary.sessionEntry && summary.sessionEntry.cwd) || meta.cwd,
    jsonlPath: meta.file,
  };
}

// Aggregate everything. Caller filters by range.
async function buildAll(range) {
  const cacheKey = `all_${range || 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const cutoff = rangeToCutoff(range, now);
  const cutoffMs = cutoff ? cutoff.getTime() : 0;
  const pricingMap = await pricing.fetchPricing();

  const files = await parsers.listSessionFiles();
  // Use mtime as a quick file-level filter — sessions older than cutoff can't have in-range messages.
  const eligible = cutoffMs ? files.filter((f) => f.mtimeMs >= cutoffMs - 24 * 3600 * 1000) : files;

  // Bounded-concurrency parse — JSONL files are I/O bound; >8 risks FD pressure.
  const CONCURRENCY = 8;
  const sessions = [];
  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const chunk = eligible.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map(async (meta) => {
      try { return { meta, detail: await buildSessionDetail(meta, pricingMap) }; }
      catch (err) { console.warn('[pi-cost] failed to read', meta.file, err.message); return null; }
    }));
    for (const s of settled) if (s) sessions.push(s);
  }

  // Project rollup.
  const projects = new Map();
  const daily = {};
  const modelTotals = {};
  let totalCost = 0;
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
  let totalSessions = 0;
  let totalMessages = 0;
  const sourceCounts = { jsonl: 0, pricing: 0, none: 0 };

  const sessionSummaries = [];

  for (const { meta, detail } of sessions) {
    const inRange = cutoff
      ? detail.messages.filter((m) => m.ts && new Date(m.ts).getTime() >= cutoffMs)
      : detail.messages;
    if (inRange.length === 0 && cutoff) continue;

    let sCost = 0, sIn = 0, sOut = 0, sCR = 0, sCW = 0;
    const projDaily = projects.get(meta.projectDir)?.daily || {};
    for (const m of inRange) {
      sCost += m.cost;
      sIn += m.input;
      sOut += m.output;
      sCR += m.cacheRead;
      sCW += m.cacheWrite;
      const day = localDateStr(new Date(m.ts));
      daily[day] = daily[day] || { cost: 0 };
      daily[day].cost += m.cost;
      projDaily[day] = (projDaily[day] || 0) + m.cost;
      if (m.model) modelTotals[m.model] = (modelTotals[m.model] || 0) + m.cost;
      sourceCounts[m.costSource] = (sourceCounts[m.costSource] || 0) + 1;
    }

    totalCost += sCost;
    totalInput += sIn; totalOutput += sOut; totalCacheRead += sCR; totalCacheWrite += sCW;
    totalSessions++;
    totalMessages += inRange.length;

    const proj = projects.get(meta.projectDir) || {
      projectDir: meta.projectDir,
      cwd: detail.cwd,
      name: path.basename(detail.cwd) || detail.cwd,
      totalCost: 0,
      sessions: 0,
      totalTokens: 0,
      lastActive: null,
      models: new Map(),
      daily: projDaily,
    };
    proj.totalCost += sCost;
    proj.sessions++;
    proj.totalTokens += sIn + sOut + sCR + sCW;
    const last = inRange[inRange.length - 1]?.ts || detail.lastTimestamp;
    if (!proj.lastActive || (last && last > proj.lastActive)) proj.lastActive = last;
    for (const m of inRange) {
      if (!m.model) continue;
      proj.models.set(m.model, (proj.models.get(m.model) || 0) + m.cost);
    }
    projects.set(meta.projectDir, proj);

    sessionSummaries.push({
      id: detail.id,
      projectDir: meta.projectDir,
      cwd: detail.cwd,
      customTitle: detail.customTitle,
      firstUserText: detail.firstUserText,
      provider: detail.provider,
      model: detail.model,
      models: detail.models,
      totalCost: sCost,
      totalTokens: sIn + sOut + sCR + sCW,
      messageCount: inRange.length,
      firstTimestamp: detail.firstTimestamp,
      lastTimestamp: last,
      parentSession: detail.parentSession,
      jsonlPath: meta.file,
      inlineSubCost: detail.inlineSubCost || 0,
      inlineSubTokens: detail.inlineSubTokens || 0,
      inlineSubCount: detail.inlineSubCount || 0,
    });
  }

  // Subagent rollup: subagents are separate JSONL files whose `parentSession`
  // points to the parent's file path. Project/overview totals already include
  // them; here we surface a per-parent aggregate so the detail view can show
  // "self + spawned" cost.
  const childrenByParent = new Map();
  for (const s of sessionSummaries) {
    if (!s.parentSession) continue;
    const key = normalizePath(s.parentSession);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(s);
  }
  for (const s of sessionSummaries) {
    const kids = childrenByParent.get(normalizePath(s.jsonlPath)) || [];
    s.subagentCount = kids.length + (s.inlineSubCount || 0);
    s.subagentCost = kids.reduce((a, c) => a + c.totalCost, 0) + (s.inlineSubCost || 0);
    s.subagentTokens = kids.reduce((a, c) => a + c.totalTokens, 0) + (s.inlineSubTokens || 0);
    s.subagentIds = kids.map((c) => c.id);
  }

  const todayStr = localDateStr(now);
  const todayCost = daily[todayStr]?.cost || 0;

  const dailyStart = cutoff ? new Date(cutoff) : (() => {
    const dates = Object.keys(daily).sort();
    return dates.length ? new Date(dates[0] + 'T00:00:00') : new Date(now);
  })();
  dailyStart.setHours(0, 0, 0, 0);
  const dailyArr = fillDaily(daily, dailyStart, now);

  const modelDistribution = Object.entries(modelTotals)
    .filter(([, c]) => c > 0)
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);

  const projectsArr = [...projects.values()].map((p) => ({
    projectDir: p.projectDir,
    cwd: p.cwd,
    name: p.name,
    totalCost: p.totalCost,
    sessions: p.sessions,
    totalTokens: p.totalTokens,
    lastActive: p.lastActive,
    primaryModel: [...p.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown',
    models: [...p.models.keys()],
    daily: p.daily,
    modelTotals: Object.fromEntries(p.models),
  })).sort((a, b) => b.totalCost - a.totalCost);

  const cacheInputAll = totalInput + totalCacheRead + totalCacheWrite;
  const cacheEfficiency = cacheInputAll > 0 ? totalCacheRead / cacheInputAll : 0;

  const result = {
    summary: {
      totalCost, todayCost,
      totalSessions, totalMessages,
      totalInput, totalOutput, totalCacheRead, totalCacheWrite,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      cacheEfficiency,
      sourceCounts,
    },
    daily: dailyArr,
    modelDistribution,
    projects: projectsArr,
    sessions: sessionSummaries,
    pricingMeta: pricing.getMeta(),
    generatedAt: new Date().toISOString(),
  };

  cacheSet(cacheKey, result);
  return result;
}

// #endregion

// #region EXPRESS

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseRange(raw, fallback = null) {
  if (raw === 'today') return 'today';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

app.get('/api/themes', (_req, res) => {
  res.json({
    light: resolveActiveTheme('light'),
    dark: resolveActiveTheme('dark'),
    config: { lightId: LIGHT_THEME_ID, darkId: DARK_THEME_ID, themeDir: USER_THEME_DIR },
  });
});

app.get('/pi-config', (_req, res) => {
  res.json({
    piDir: parsers.getPiDir(),
    sessionsDir: parsers.getSessionsDir(),
    port: PORT,
  });
});

app.get('/api/overview', async (req, res) => {
  try {
    const range = parseRange(req.query.range, 30);
    const all = await buildAll(range);
    res.json({
      summary: all.summary,
      daily: all.daily,
      modelDistribution: all.modelDistribution,
      projects: all.projects.map(stripInternal),
      pricingMeta: all.pricingMeta,
      generatedAt: all.generatedAt,
    });
  } catch (err) {
    console.error('[api] overview:', err);
    res.status(500).json({ error: err.message });
  }
});

function stripInternal(p) {
  const { daily: _d, modelTotals: _m, ...rest } = p;
  return rest;
}

app.get('/api/projects', async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const all = await buildAll(range);
    res.json({ projects: all.projects.map(stripInternal) });
  } catch (err) {
    console.error('[api] projects:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:encoded/sessions', async (req, res) => {
  try {
    const range = parseRange(req.query.range);
    const all = await buildAll(range);
    const decoded = decodeURIComponent(req.params.encoded);
    const project = all.projects.find((p) => p.projectDir === decoded);
    const sessions = all.sessions
      .filter((s) => s.projectDir === decoded)
      .sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));

    const now = new Date();
    const cutoff = rangeToCutoff(range, now);
    const dailyStart = cutoff ? new Date(cutoff) : new Date(now.getTime() - 30 * 86400 * 1000);
    dailyStart.setHours(0, 0, 0, 0);
    const dailyMap = {};
    for (const [day, cost] of Object.entries(project?.daily || {})) dailyMap[day] = { cost };
    const dailyArr = fillDaily(dailyMap, dailyStart, now);

    const modelDistribution = Object.entries(project?.modelTotals || {})
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost);

    res.json({ project, sessions, daily: dailyArr, modelDistribution });
  } catch (err) {
    console.error('[api] project sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const meta = await findSessionFileById(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    const pricingMap = await pricing.fetchPricing();
    const detail = await buildSessionDetail(meta, pricingMap);
    detail.pricingMeta = pricing.getMeta();
    detail.encodedProjectDir = encodeURIComponent(meta.projectDir);

    // Sibling subagents (legacy: separate JSONL files with parentSession).
    // Inline runs (pi v3 nested format) are already merged into detail.messages.
    const all = await buildAll(null);
    const self = all.sessions.find((s) => s.id === detail.id);
    detail.childSessions = self
      ? all.sessions
          .filter((s) => s.parentSession && normalizePath(s.parentSession) === normalizePath(self.jsonlPath))
          .map((c) => ({
            id: c.id, customTitle: c.customTitle, firstUserText: c.firstUserText,
            totalCost: c.totalCost, totalTokens: c.totalTokens, messageCount: c.messageCount,
            model: c.model, provider: c.provider, lastTimestamp: c.lastTimestamp,
          }))
      : [];

    res.json(detail);
  } catch (err) {
    console.error('[api] session detail:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pricing', async (_req, res) => {
  try {
    const map = await pricing.fetchPricing();
    const models = [];
    for (const [key, info] of map) {
      models.push({
        key,
        input: info.input_cost_per_token,
        output: info.output_cost_per_token,
        cacheRead: info.cache_read_input_token_cost,
        cacheWrite: info.cache_creation_input_token_cost,
      });
    }
    res.json({ models, ...pricing.getMeta() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', async (_req, res) => {
  cacheClear();
  parsers.invalidateSessionCache();
  pricing.refresh();
  nestedIndexPromise = null;
  res.json({ ok: true });
});

// #endregion

// #region STARTUP

loadAllThemes().then(() => {
  console.log(`themes loaded: ${themes.size} (user dir: ${USER_THEME_DIR})`);
}).catch((e) => console.warn('themes: load failed:', e.message));

const server = http.createServer({ maxHeaderSize: 32768 }, app).listen(PORT, () => {
  const actualPort = server.address().port;
  console.log(`pi-cost dashboard running at http://localhost:${actualPort}`);
  console.log(`Sessions dir: ${parsers.getSessionsDir()}`);
  if (process.argv.includes('--open')) {
    import('open').then((mod) => mod.default(`http://localhost:${actualPort}`)).catch(() => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, trying random port...`);
    const fallback = http.createServer({ maxHeaderSize: 32768 }, app).listen(0, () => {
      const p = fallback.address().port;
      console.log(`pi-cost dashboard running at http://localhost:${p}`);
      if (process.argv.includes('--open')) {
        import('open').then((mod) => mod.default(`http://localhost:${p}`)).catch(() => {});
      }
    });
  } else {
    throw err;
  }
});

pricing.fetchPricing().catch(() => {});

// #endregion
