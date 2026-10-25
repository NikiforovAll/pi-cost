'use strict';

const path = require('node:path');
const parsers = require('./pi-parsers-cost');
const pricing = require('./pi-pricing');

// #region CACHE

const CACHE_TTL = 30_000;
// Custom from/to windows make the key space unbounded, so the cache is capped.
const MAX_CACHE_ENTRIES = 50;
const dataCache = new Map();

function getCache(key) {
  const hit = dataCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts >= CACHE_TTL) {
    dataCache.delete(key);
    return undefined;
  }
  return hit.data;
}

function setCache(key, data) {
  dataCache.delete(key);
  dataCache.set(key, { data, ts: Date.now() });
  while (dataCache.size > MAX_CACHE_ENTRIES) dataCache.delete(dataCache.keys().next().value);
}

// Keyed by file; a hit needs the same mtime, size and pricing fetch. Holds the build promise, so
// concurrent requests share one parse.
const sessionModelCache = new Map();

function invalidateAllCache() {
  dataCache.clear();
  sessionModelCache.clear();
  nestedIndexPromise = null;
  parsers.invalidateSessionCache();
}

// #endregion

// #region RANGE

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHourStr(d) {
  return `${localDateStr(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

// An hour key extends the day key, so a startsWith test on a day string matches either granularity.
const BUCKETS = {
  day: { key: localDateStr, floor: (d) => d.setHours(0, 0, 0, 0), next: (d) => d.setDate(d.getDate() + 1) },
  hour: { key: localHourStr, floor: (d) => d.setMinutes(0, 0, 0), next: (d) => d.setHours(d.getHours() + 1) },
};

// A range is a preset ('today', '24h', N calendar days, null for all time) or a custom window of
// two local YYYY-MM-DD dates.
function isCustomRange(range) {
  return !!range && typeof range === 'object' && !!range.from && !!range.to;
}

function rangeBucket(range) {
  if (isCustomRange(range)) return range.from === range.to ? 'hour' : 'day';
  return range === 'today' || range === '24h' ? 'hour' : 'day';
}

function localDayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function localDayEnd(dateStr) {
  const d = localDayStart(dateStr);
  d.setHours(23, 59, 59, 999);
  return d;
}

function rangeToCutoff(range, now) {
  if (isCustomRange(range)) return localDayStart(range.from);
  if (range === 'today') {
    const c = new Date(now);
    c.setHours(0, 0, 0, 0);
    return c;
  }
  if (range === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (!range) return null;
  // N calendar days ending today, so the chart draws exactly N buckets.
  const c = new Date(now);
  c.setDate(c.getDate() - (range - 1));
  c.setHours(0, 0, 0, 0);
  return c;
}

// Anchored to one captured `now` so the bounds of a request cannot disagree. Presets keep an open
// upper bound (endStr null), so a row a live session writes mid-request is not dropped.
function resolveWindow(range, now = new Date()) {
  const cutoff = rangeToCutoff(range, now);
  const end = isCustomRange(range) ? localDayEnd(range.to) : new Date(now);
  const todayStr = localDateStr(now);
  return {
    now,
    cutoff,
    end,
    cutoffStr: cutoff ? cutoff.toISOString() : null,
    endStr: isCustomRange(range) ? end.toISOString() : null,
    hasToday: (!cutoff || localDateStr(cutoff) <= todayStr) && localDateStr(end) >= todayStr,
  };
}

// pi writes ISO UTC timestamps, so string order is time order.
function filterWindow(messages, fromStr, toStr) {
  if (!fromStr && !toStr) return messages;
  return messages.filter((m) => m.ts && (!fromStr || m.ts >= fromStr) && (!toStr || m.ts <= toStr));
}

function rangeKey(range) {
  if (isCustomRange(range)) return `${range.from}_${range.to}`;
  return range || 'all';
}

const MAX_RANGE_DAYS = 3660;

// One calendar day is today, so it is returned as 'today'.
function parseRange(raw, fallback = null) {
  if (raw === 'today' || raw === '24h') return raw;
  if (raw === 'all') return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  if (n === 0) return null;
  if (n === 1) return 'today';
  return Math.min(n, MAX_RANGE_DAYS);
}

const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/;

// undefined for absent, null for malformed.
function parseDateParam(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !DATE_PARAM.test(raw)) return null;
  return localDateStr(localDayStart(raw)) === raw ? raw : null;
}

// `from`/`to` win over `range`. A reversed pair is ordered and both ends are clamped to today.
// undefined when no window was asked for, null when one was but is malformed.
function parseCustomRange(query) {
  const from = parseDateParam(query.from);
  const to = parseDateParam(query.to);
  if (from === null || to === null) return null;
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined || to === undefined) return null;
  const today = localDateStr(new Date());
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { from: lo > today ? today : lo, to: hi > today ? today : hi };
}

// An encoded project dir. Only used as a key, never joined into a path.
function parseProject(raw) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) return null;
  return raw;
}

// #endregion

// #region SESSION_MODEL

const stripEffort = (m) => (m ? String(m).replace(/:(low|medium|high|xhigh|minimal|off)$/, '') : m);
const tokensOf = (m) => m.input + m.output + m.cacheRead + m.cacheWrite;

// pi-subagents records a run's model as `<provider>/<model id>`; the id itself may hold a slash.
function splitRunModel(raw) {
  const i = raw ? raw.indexOf('/') : -1;
  return i > 0 ? { provider: raw.slice(0, i), model: raw.slice(i + 1) } : { provider: null, model: raw || null };
}

const IO_CONCURRENCY = 16;

// Runs fn over items with at most `limit` in flight; results keep the input order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Nested subagent session file (by pathKey) -> its session id, so a run row can link to it.
let nestedIndexPromise = null;
function loadNestedIndex() {
  if (nestedIndexPromise) return nestedIndexPromise;
  nestedIndexPromise = (async () => {
    const files = await parsers.listNestedSubagentFiles();
    const map = new Map();
    await mapLimit(files, IO_CONCURRENCY, async (f) => {
      const header = await parsers.readSessionHeader(f.file);
      if (header) map.set(parsers.pathKey(f.file), { ...f, id: header.id });
    });
    return map;
  })();
  return nestedIndexPromise;
}

function usageRow(u, est, pricingMap) {
  return {
    ts: u.ts,
    provider: u.provider || null,
    model: u.model || null,
    input: u.usage.input || 0,
    output: u.usage.output || 0,
    cacheRead: u.usage.cacheRead || 0,
    cacheWrite: u.usage.cacheWrite || 0,
    cost: est.cost,
    costSource: est.source,
    modelKey: est.modelKey,
    cacheSavings: pricing.cacheReadSaving(pricingMap, u.provider, u.model, u.usage),
  };
}

// One session, independent of any range: every billed row (assistant turn, compaction summary,
// inline subagent run) in time order with a running total.
async function buildSessionModel(meta, { pricingMap, nestedIndex }) {
  const entries = await parsers.readSessionEntriesUncached(meta.file);
  const summary = parsers.summarize(entries);
  const rows = [];
  const seen = new Set();

  for (const u of parsers.enumerateMessageUsages(entries)) {
    if (u.messageId) {
      if (seen.has(u.messageId)) continue;
      seen.add(u.messageId);
    }
    const row = usageRow(u, pricing.estimate(pricingMap, u.provider, u.model, u.usage), pricingMap);
    if (u.compaction) row.compaction = u.compaction;
    if (u.tools?.length) row.tools = u.tools;
    if (u.durationMs) row.durationMs = u.durationMs;
    rows.push(row);
  }

  for (const r of parsers.enumerateSubagentRuns(entries)) {
    const { provider, model } = splitRunModel(stripEffort(r.model));
    const u = { ts: r.ts, provider, model, usage: r.usage };
    const row = usageRow(u, pricing.estimate(pricingMap, provider, model, r.usage), pricingMap);
    const nested = r.jsonlPath ? nestedIndex.get(parsers.pathKey(r.jsonlPath)) : null;
    row.subagent = {
      agent: r.agent,
      task: r.task,
      sessionId: nested ? nested.id : null,
      turns: r.turns,
      runId: r.runId,
      exitCode: r.exitCode,
    };
    rows.push(row);
  }

  rows.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  let cumulative = 0;
  rows.forEach((m, i) => {
    cumulative += m.cost;
    m.index = i + 1;
    m.cumulativeCost = cumulative;
  });

  const header = summary.sessionEntry || {};
  const cwd = header.cwd || meta.cwd;
  return {
    id: header.id || parsers.slugFromFile(meta.file),
    projectDir: meta.projectDir,
    cwd,
    projectName: path.basename(cwd) || cwd,
    jsonlPath: meta.file,
    parentSession: summary.parentSession || null,
    customTitle: summary.customTitle,
    firstUserText: summary.firstUserText,
    provider: summary.provider,
    model: summary.model,
    firstTimestamp: summary.firstTimestamp,
    lastTimestamp: summary.lastTimestamp || meta.mtime.toISOString(),
    compactionEvents: [...parsers.enumerateCompactions(entries)],
    messages: rows,
  };
}

const MTIME_SLACK_MS = 24 * 3600 * 1000;
const PARSE_CONCURRENCY = 8;

async function modelContext() {
  const pricingMap = await pricing.fetchPricing();
  return { pricingMap, stamp: pricing.getMeta().fetchedAt, nestedIndex: await loadNestedIndex() };
}

function sessionModel(meta, ctx) {
  const key = `${meta.mtimeMs}:${meta.size}:${ctx.stamp}`;
  const hit = sessionModelCache.get(meta.file);
  if (hit && hit.key === key) return hit.promise;
  const promise = buildSessionModel(meta, ctx).catch((err) => {
    console.warn('[pi-cost] failed to read', meta.file, err.message);
    if (sessionModelCache.get(meta.file)?.promise === promise) sessionModelCache.delete(meta.file);
    return null;
  });
  sessionModelCache.set(meta.file, { key, promise });
  return promise;
}

// Sessions whose file was last written before the cutoff cannot hold rows inside the window.
async function loadSessions(cutoff) {
  const ctx = await modelContext();
  const files = await parsers.listSessionFiles();
  const cutoffMs = cutoff ? cutoff.getTime() - MTIME_SLACK_MS : 0;
  const eligible = files.filter((f) => f.mtimeMs >= cutoffMs);
  return (await mapLimit(eligible, PARSE_CONCURRENCY, (meta) => sessionModel(meta, ctx))).filter(Boolean);
}

function findSessionMeta(id, top, headers, nestedIndex) {
  const bySlug = top.find((f) => parsers.slugFromFile(f.file) === id);
  if (bySlug) return bySlug;
  for (const entry of nestedIndex.values()) if (entry.id === id) return entry;
  const i = headers.findIndex((h) => h?.id === id);
  return i === -1 ? null : top[i];
}

// #endregion

// #region AGGREGATION

function summarizeMessages(msgs) {
  const sum = { messageCount: msgs.length, totalCost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of msgs) {
    sum.totalCost += m.cost;
    sum.input += m.input;
    sum.output += m.output;
    sum.cacheRead += m.cacheRead;
    sum.cacheWrite += m.cacheWrite;
  }
  sum.totalTokens = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
  return sum;
}

// Share of input tokens served from cache.
function cacheEfficiency(sum) {
  const inputAll = sum.input + sum.cacheRead + sum.cacheWrite;
  return inputAll > 0 ? sum.cacheRead / inputAll : 0;
}

// Only compactions that recorded usage are billed rows; tokensBefore is what the summary replaced.
function summarizeCompactions(msgs) {
  const sum = { count: 0, totalCost: 0, tokensBefore: 0 };
  for (const m of msgs) {
    if (!m.compaction) continue;
    sum.count++;
    sum.totalCost += m.cost;
    sum.tokensBefore += m.compaction.tokensBefore;
  }
  return sum;
}

function countBy(msgs, keyFn) {
  const counts = {};
  for (const m of msgs) {
    const k = keyFn(m);
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function topKey(counts) {
  let best = null;
  for (const [k, n] of Object.entries(counts)) if (!best || n > counts[best]) best = k;
  return best;
}

function addBucketModelCost(acc, key, model, cost) {
  const mk = model || 'other';
  acc[key] ||= {};
  acc[key][mk] = (acc[key][mk] || 0) + cost;
}

// Gap-filled so empty buckets stay visible. The bucket total is derived from the per-model map.
function buildCostSeries(modelCostsByBucket, start, end, bucket) {
  const b = BUCKETS[bucket];
  const points = [];
  if (Object.keys(modelCostsByBucket).length === 0) return points;
  const d = new Date(start);
  b.floor(d);
  for (; d <= end; b.next(d)) {
    const k = b.key(d);
    const byModel = modelCostsByBucket[k] || {};
    points.push({ key: k, cost: Object.values(byModel).reduce((s, v) => s + v, 0), byModel });
  }
  return points;
}

function buildModelDistribution(modelCosts) {
  return Object.entries(modelCosts)
    .filter(([, cost]) => cost > 0)
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);
}

// Series start for the all-time range: the first bucket that has cost.
function seriesStart(w, bucketCosts) {
  if (w.cutoff) return w.cutoff;
  const first = Object.keys(bucketCosts).sort()[0];
  return first ? localDayStart(first.slice(0, 10)) : w.now;
}

function sessionRow(session, msgs) {
  const sum = summarizeMessages(msgs);
  const sub = msgs.filter((m) => m.subagent);
  const durationMs = session.firstTimestamp && session.lastTimestamp
    ? new Date(session.lastTimestamp) - new Date(session.firstTimestamp)
    : 0;
  return {
    id: session.id,
    projectDir: session.projectDir,
    projectName: session.projectName,
    cwd: session.cwd,
    customTitle: session.customTitle,
    firstUserText: session.firstUserText,
    provider: session.provider,
    model: session.model,
    models: [...new Set(msgs.map((m) => m.model).filter(Boolean))],
    primaryModel: topKey(countBy(msgs, (m) => m.model)) || session.model || 'unknown',
    ...sum,
    sourceCounts: { jsonl: 0, pricing: 0, none: 0, ...countBy(msgs, (m) => m.costSource) },
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: msgs.at(-1)?.ts || session.lastTimestamp,
    durationMinutes: Math.round(Math.max(0, durationMs) / 60000),
    compactions: summarizeCompactions(msgs),
    subagentCount: sub.length,
    subagentCost: sub.reduce((s, m) => s + m.cost, 0),
    subagentTokens: sub.reduce((s, m) => s + tokensOf(m), 0),
    parentSession: session.parentSession,
    jsonlPath: session.jsonlPath,
  };
}

// Rows scoped to the window, one per session that has any.
async function windowedSessions(range, projectFilter) {
  const w = resolveWindow(range);
  const sessions = await loadSessions(w.cutoff);
  const out = [];
  for (const s of sessions) {
    if (projectFilter && s.projectDir !== projectFilter) continue;
    const msgs = filterWindow(s.messages, w.cutoffStr, w.endStr);
    if (msgs.length) out.push({ session: s, msgs });
  }
  return { w, scoped: out };
}

function seriesAndModels(scoped, range, w) {
  const bucket = rangeBucket(range);
  const bucketKey = BUCKETS[bucket].key;
  const bucketCosts = {};
  const modelCosts = {};
  for (const { msgs } of scoped) {
    for (const m of msgs) {
      addBucketModelCost(bucketCosts, bucketKey(new Date(m.ts)), m.model, m.cost);
      if (m.model) modelCosts[m.model] = (modelCosts[m.model] || 0) + m.cost;
    }
  }
  return {
    costSeries: { bucket, points: buildCostSeries(bucketCosts, seriesStart(w, bucketCosts), w.end, bucket) },
    modelDistribution: buildModelDistribution(modelCosts),
  };
}

function projectSummaries(scoped) {
  const projects = new Map();
  for (const { session, msgs } of scoped) {
    let p = projects.get(session.projectDir);
    if (!p) {
      p = { projectDir: session.projectDir, cwd: session.cwd, name: session.projectName, totalCost: 0, sessions: 0, totalTokens: 0, lastActive: null, modelCosts: {} };
      projects.set(session.projectDir, p);
    }
    const sum = summarizeMessages(msgs);
    p.totalCost += sum.totalCost;
    p.totalTokens += sum.totalTokens;
    p.sessions++;
    const last = msgs.at(-1).ts;
    if (!p.lastActive || last > p.lastActive) p.lastActive = last;
    for (const m of msgs) if (m.model) p.modelCosts[m.model] = (p.modelCosts[m.model] || 0) + m.cost;
  }
  return [...projects.values()].map(({ modelCosts, ...p }) => {
    const models = Object.keys(modelCosts).sort((a, b) => modelCosts[b] - modelCosts[a]);
    return { ...p, models, primaryModel: models[0] || 'unknown' };
  }).sort((a, b) => b.totalCost - a.totalCost);
}

async function cached(key, build) {
  const hit = getCache(key);
  if (hit !== undefined) return hit;
  const data = await build();
  setCache(key, data);
  return data;
}

function getOverviewData(range, projectFilter) {
  return cached(`overview_${rangeKey(range)}_${projectFilter || 'all'}`, async () => {
    const { w, scoped } = await windowedSessions(range, projectFilter);
    const { costSeries, modelDistribution } = seriesAndModels(scoped, range, w);
    const all = scoped.flatMap((s) => s.msgs);
    const sum = summarizeMessages(all);
    const todayStr = localDateStr(w.now);
    const todayCost = w.hasToday
      ? all.filter((m) => localDateStr(new Date(m.ts)) === todayStr).reduce((s, m) => s + m.cost, 0)
      : null;
    return {
      summary: {
        totalCost: sum.totalCost,
        todayCost,
        totalSessions: scoped.length,
        totalMessages: sum.messageCount,
        totalInput: sum.input,
        totalOutput: sum.output,
        totalCacheRead: sum.cacheRead,
        totalCacheWrite: sum.cacheWrite,
        totalTokens: sum.totalTokens,
        cacheEfficiency: cacheEfficiency(sum),
        sourceCounts: { jsonl: 0, pricing: 0, none: 0, ...countBy(all, (m) => m.costSource) },
      },
      costSeries,
      modelDistribution,
      projects: projectSummaries(scoped),
      pricingMeta: pricing.getMeta(),
      generatedAt: new Date().toISOString(),
    };
  });
}

function getProjectsData(range) {
  return cached(`projects_${rangeKey(range)}`, async () => {
    const { scoped } = await windowedSessions(range);
    return { projects: projectSummaries(scoped) };
  });
}

// One row per scoped session. Forked sessions point at their parent's file through `parentSession`.
function sessionRows(scoped) {
  const rows = scoped.map(({ session, msgs }) => sessionRow(session, msgs));
  const byParent = new Map();
  for (const r of rows) {
    if (!r.parentSession) continue;
    const k = parsers.pathKey(r.parentSession);
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }
  for (const r of rows) {
    const kids = byParent.get(parsers.pathKey(r.jsonlPath)) || [];
    r.childIds = kids.map((k) => k.id);
    r.childCost = kids.reduce((s, k) => s + k.totalCost, 0);
  }
  return rows;
}

function getProjectSessionsData(projectDir, range) {
  return cached(`sessions_${projectDir}_${rangeKey(range)}`, async () => {
    const { w, scoped } = await windowedSessions(range, projectDir);
    const { costSeries, modelDistribution } = seriesAndModels(scoped, range, w);
    const sessions = sessionRows(scoped).sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
    return { project: projectSummaries(scoped)[0] || null, sessions, costSeries, modelDistribution };
  });
}

function getAllSessionsData(range, projectFilter) {
  return cached(`sessions_all_${rangeKey(range)}_${projectFilter || 'all'}`, async () => {
    const { scoped } = await windowedSessions(range, projectFilter);
    return { sessions: sessionRows(scoped).sort((a, b) => b.totalCost - a.totalCost) };
  });
}

// pi-subagents runs grouped by agent name.
function getAgentsData(range, projectFilter) {
  return cached(`agents_${rangeKey(range)}_${projectFilter || 'all'}`, async () => {
    const { scoped } = await windowedSessions(range, projectFilter);
    const groups = new Map();
    for (const { session, msgs } of scoped) {
      for (const m of msgs) {
        if (!m.subagent) continue;
        const name = m.subagent.agent || 'unknown';
        let g = groups.get(name);
        if (!g) groups.set(name, (g = { name, runs: 0, totalCost: 0, totalTokens: 0, failures: 0, sessions: new Set(), models: new Set(), costliest: null }));
        g.runs++;
        g.totalCost += m.cost;
        g.totalTokens += tokensOf(m);
        if (m.subagent.exitCode) g.failures++;
        if (m.model) g.models.add(m.model);
        g.sessions.add(session.id);
        if (!g.costliest || m.cost > g.costliest.cost) {
          g.costliest = { cost: m.cost, sessionId: session.id, runSessionId: m.subagent.sessionId, task: m.subagent.task, projectName: session.projectName };
        }
      }
    }
    const agents = [...groups.values()]
      .map(({ sessions, models, ...g }) => ({ ...g, models: [...models], sessionCount: sessions.size, avgCost: g.totalCost / g.runs }))
      .sort((a, b) => b.totalCost - a.totalCost);
    return { agents };
  });
}

// Parent and forks come from the session headers, so only the session and its relatives are parsed.
function getSessionDetailData(id) {
  return cached(`detail_${id}`, async () => {
    const ctx = await modelContext();
    const top = await parsers.listSessionFiles();
    const headers = await mapLimit(top, IO_CONCURRENCY, (f) => parsers.readSessionHeader(f.file));
    const meta = findSessionMeta(id, top, headers, ctx.nestedIndex);
    if (!meta) return null;
    const session = await sessionModel(meta, ctx);
    if (!session) return null;
    const self = parsers.pathKey(session.jsonlPath);
    const parentKey = session.parentSession ? parsers.pathKey(session.parentSession) : null;
    const childMetas = top.filter((f, i) => headers[i]?.parentSession && parsers.pathKey(headers[i].parentSession) === self);
    const parentMeta = parentKey ? top.find((f) => parsers.pathKey(f.file) === parentKey) : null;
    const [children, parent] = await Promise.all([
      Promise.all(childMetas.map((m) => sessionModel(m, ctx))),
      parentMeta ? sessionModel(parentMeta, ctx) : null,
    ]);
    return {
      ...sessionRow(session, session.messages),
      encodedProjectDir: encodeURIComponent(session.projectDir),
      parent: parent ? { id: parent.id, title: parent.customTitle || parent.firstUserText || parent.id } : null,
      compactionEvents: session.compactionEvents,
      childSessions: children.filter(Boolean).map((c) => sessionRow(c, c.messages)),
      messages: session.messages,
      pricingMeta: pricing.getMeta(),
    };
  });
}

// The detail view is the whole session. `inRange` / `today` reconcile it with the range-scoped
// row that linked here. Derived outside the cache so switching ranges does not re-read the file.
function withSessionSlices(base, range) {
  const w = resolveWindow(range);
  const slice = (fromStr) => summarizeMessages(filterWindow(base.messages, fromStr, w.endStr));
  const inRange = w.cutoffStr || w.endStr ? slice(w.cutoffStr) : null;
  const todayStart = rangeToCutoff('today', w.now).toISOString();
  return {
    ...base,
    range,
    inRange,
    today: w.hasToday ? slice(todayStart) : null,
  };
}

// #endregion

// #region INSIGHTS

// pi has no rate-limit data, so a block is the ccusage heuristic only: it opens at the first
// activity floored to the hour and spans 5 h. No block is marked as the current one.
const BLOCK_MS = 5 * 60 * 60 * 1000;
const HEATMAP_DAYS = 7;
const MAX_BLOCKS = 24;
const MAX_TOOLS = 20;

function computeBlocks(messages) {
  const blocks = [];
  let cur = null;
  for (const m of messages) {
    const t = new Date(m.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (!cur || t >= cur.startMs + BLOCK_MS) {
      const start = new Date(t);
      start.setMinutes(0, 0, 0);
      cur = { startMs: start.getTime(), lastMs: t, cost: 0, tokens: 0, messageCount: 0, models: new Set() };
      blocks.push(cur);
    }
    if (t > cur.lastMs) cur.lastMs = t;
    cur.cost += m.cost;
    cur.tokens += tokensOf(m);
    cur.messageCount++;
    if (m.model) cur.models.add(m.model);
  }
  return blocks.reverse().slice(0, MAX_BLOCKS).map((b) => ({
    start: new Date(b.startMs).toISOString(),
    end: new Date(b.startMs + BLOCK_MS).toISOString(),
    lastActivity: new Date(b.lastMs).toISOString(),
    cost: b.cost,
    tokens: b.tokens,
    messageCount: b.messageCount,
    models: [...b.models],
  }));
}

function getInsightsData(range, projectFilter) {
  return cached(`insights_${rangeKey(range)}_${projectFilter || 'all'}`, async () => {
    const w = resolveWindow(range);
    // The heatmap is the last 7 real days ending at the window end, so a short range keeps a week of context.
    const windowEnd = w.end < w.now ? w.end : w.now;
    const hmStart = new Date(windowEnd);
    hmStart.setHours(0, 0, 0, 0);
    hmStart.setDate(hmStart.getDate() - (HEATMAP_DAYS - 1));
    const hmStartStr = hmStart.toISOString();
    const scanCutoff = w.cutoff === null ? null : w.cutoff < hmStart ? w.cutoff : hmStart;
    const sessions = (await loadSessions(scanCutoff)).filter((s) => !projectFilter || s.projectDir === projectFilter);

    const byTs = (a, b) => a.ts.localeCompare(b.ts);
    const all = sessions.flatMap((s) => filterWindow(s.messages, w.cutoffStr, w.endStr)).sort(byTs);
    const hmMsgs = sessions.flatMap((s) => filterWindow(s.messages, hmStartStr, w.endStr));

    const sum = summarizeMessages(all);
    const heatmap = Array.from({ length: HEATMAP_DAYS }, () => new Array(24).fill(0));
    const heatmapDays = Array.from({ length: HEATMAP_DAYS }, (_, i) => {
      const d = new Date(hmStart);
      d.setDate(d.getDate() + i);
      return localDateStr(d);
    });
    const toolCounts = {};
    let cacheSavings = 0;
    let mainCost = 0;
    let subagentCost = 0;
    let subagentRuns = 0;
    const weekly = {};

    for (const m of all) {
      cacheSavings += m.cacheSavings || 0;
      const monday = new Date(m.ts);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const wk = localDateStr(monday);
      weekly[wk] = (weekly[wk] || 0) + m.cost;
      if (m.subagent) {
        subagentCost += m.cost;
        subagentRuns++;
      } else {
        mainCost += m.cost;
        if (m.tools) for (const t of m.tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
      }
    }

    for (const m of hmMsgs) {
      const d = new Date(m.ts);
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      // Rounded so a 23 h or 25 h DST day still lands on its row.
      const idx = Math.round((day - hmStart) / 86400000);
      if (idx >= 0 && idx < HEATMAP_DAYS) heatmap[idx][d.getHours()] += m.cost;
    }

    const windowStart = w.cutoff || (all.length ? new Date(all[0].ts) : w.now);
    const dayCount = Math.max(1, Math.ceil((windowEnd - windowStart) / 86400000));
    const dailyAvg = sum.totalCost / dayCount;

    return {
      tokens: { input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite },
      cacheEfficiency: cacheEfficiency(sum),
      totalCost: sum.totalCost,
      cacheSavings,
      runRate: { dailyAvg, projectedMonthly: dailyAvg * 30, days: dayCount },
      blocks: computeBlocks(all),
      heatmap,
      heatmapDays,
      heatmapToday: localDateStr(w.now),
      tools: Object.entries(toolCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_TOOLS),
      subagents: { mainCost, subagentCost, runs: subagentRuns },
      compactions: summarizeCompactions(all),
      weekly: Object.entries(weekly)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, cost]) => ({ weekStart, cost })),
    };
  });
}

// #endregion

module.exports = {
  invalidateAllCache,
  getOverviewData,
  getInsightsData,
  getProjectsData,
  getProjectSessionsData,
  getAllSessionsData,
  getAgentsData,
  getSessionDetailData,
  withSessionSlices,
  parseRange,
  parseCustomRange,
  parseProject,
  resolveWindow,
  rangeBucket,
  filterWindow,
  buildCostSeries,
  computeBlocks,
  localDateStr,
};
