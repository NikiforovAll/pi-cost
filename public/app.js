// #region STATE

let currentView = 'overview';
let overviewData = null;
let insightsData = null;
let projectsData = null;
let sessionsData = null;
let sessionsCostSeries = null;
let sessionsModelDistribution = null;
let sessionDetailData = null;
let currentProjectDir = null;
let currentProjectName = null;
let currentSessionId = null;
let parentView = 'projects';
let lastSelectedProject = null;
let lastSelectedSession = null;
const DEFAULT_SORT = {
  overview: { field: 'totalCost', order: 'desc' },
  projects: { field: 'lastActive', order: 'desc' },
  sessions: { field: 'lastTimestamp', order: 'desc' },
};
const viewSort = structuredClone(DEFAULT_SORT);
// A tagged union: a rolling preset the server recomputes per request, or a concrete window of
// two local dates. Persisted as JSON under pi-cost:range (see loadDateRange).
let dateRange = { kind: 'preset', value: '3' };
const charts = {};
let lastRenderHash = {};
let navCounter = 0;
let selectedRowIdx = -1;

// #endregion

// #region UTILS

// The div.textContent -> innerHTML trick escapes only & < > because it serializes for text
// context, so a bare " breaks out of any attribute it lands in.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

// For a value inside a quoted JS string inside an HTML attribute: onclick="fn('${escAttrJs(x)}')".
// The browser HTML-decodes the attribute before the JS parser sees it, so the JS escape comes
// first. Windows paths need it: C:\Users\nikiforovall would lose \U \n as JS escapes.
function escAttrJs(value) {
  const js = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return esc(js);
}

// Storage access throws in a sandboxed frame or with site data blocked; the page must still work.
function storageGet(kind, key) {
  try {
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

function storageSet(kind, key, value) {
  try {
    window[kind].setItem(key, value);
  } catch {}
}

function storageRemove(kind, key) {
  try {
    window[kind].removeItem(key);
  } catch {}
}

function basename(p) {
  const s = String(p ?? '');
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

function formatCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(count) {
  if (!count) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function formatPct(part, total) {
  return total > 0 ? ((part / total) * 100).toFixed(1) : '0.0';
}

// Intl puts U+202F before AM/PM, which reads as a stray gap in the mono font.
function stripNarrowSpace(str) {
  return str.replace(/\u202f/g, ' ');
}

function localTime(iso, opts) {
  return stripNarrowSpace(new Date(iso).toLocaleTimeString(undefined, opts));
}

function meter(pct, { label = '', cls = '', ariaLabel = '' } = {}) {
  const width = Math.min(100, Math.max(0, Number(pct) || 0)).toFixed(1);
  const klass = esc(cls ? `meter ${cls}` : 'meter');
  return `<div class="${klass}" role="img" aria-label="${esc(ariaLabel)}">
    <div class="meter-track"><i style="width:${width}%"></i></div>
    ${label ? `<span class="meter-value">${esc(label)}</span>` : ''}
  </div>`;
}

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '<1m';
  minutes = Math.round(minutes);
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Bucket keys arrive as YYYY-MM-DD (day) or YYYY-MM-DDTHH (hour), in the server's local time.
function bucketLabel(key, bucket) {
  if (bucket === 'hour') return localTime(`${key}:00:00`, { hour: 'numeric' });
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso() {
  return isoDate(new Date());
}

function isoParts(iso) {
  return iso.split('-').map(Number);
}

function isoShift(iso, days) {
  const [y, m, d] = isoParts(iso);
  return isoDate(new Date(y, m - 1, d + days));
}

// Inclusive, so a single day counts as 1. Midday avoids a DST shift landing on a boundary.
function isoDayCount(from, to) {
  const [ay, am, ad] = isoParts(from);
  const [by, bm, bd] = isoParts(to);
  return Math.round((new Date(by, bm - 1, bd, 12) - new Date(ay, am - 1, ad, 12)) / 86400000) + 1;
}

// "AUG 12", with a two-digit year only outside the current one: "DEC 28 '25".
function isoDayLabel(iso) {
  const [y] = isoParts(iso);
  const yearTag = y === new Date().getFullYear() ? '' : ` '${String(y).slice(2)}`;
  const dayLabel = new Date(`${iso}T00:00:00`)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    .toUpperCase();
  return `${dayLabel}${yearTag}`;
}

function costSeriesTitle(series) {
  return series?.bucket === 'hour' ? 'Hourly Cost' : 'Daily Cost';
}

function shortId(id) {
  if (!id) return '—';
  return String(id).slice(0, 8);
}

function shortModel(model) {
  if (!model) return 'unknown';
  return String(model)
    .replace(/^(anthropic|openai|gemini|mistral|groq)\//, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

function srcBadge(src) {
  if (src === 'jsonl') return `<span class="src-badge src-jsonl" title="Cost recorded by pi">actual</span>`;
  if (src === 'pricing') return `<span class="src-badge src-pricing" title="Estimated from LiteLLM pricing">est</span>`;
  return `<span class="src-badge src-none" title="No pricing match">n/a</span>`;
}

function sortCompare(a, b, field, order) {
  let va = a[field],
    vb = b[field];
  if (va == null) va = '';
  if (vb == null) vb = '';
  if (typeof va === 'string') va = va.toLowerCase();
  if (typeof vb === 'string') vb = vb.toLowerCase();
  if (va < vb) return order === 'asc' ? -1 : 1;
  if (va > vb) return order === 'asc' ? 1 : -1;
  return 0;
}

function currentSort() {
  return viewSort[currentView];
}

function sortTh(field, label) {
  const s = currentSort();
  const on = s && s.field === field;
  const arrow = on ? `<span class="sort-arrow">${s.order === 'asc' ? '▲' : '▼'}</span>` : '';
  return `<th class="${on ? 'sorted' : ''}" onclick="sortBy('${escAttrJs(field)}')">${esc(label)} ${arrow}</th>`;
}

const PARENT_LABELS = { overview: 'Overview', projects: 'Projects' };

function parentBreadcrumb() {
  return `<a class="parent-breadcrumb">${esc(PARENT_LABELS[parentView] || 'Projects')}</a>`;
}

function projectsTable(rows, sort, withTokens) {
  return `<table class="data-table">
        <thead><tr>
          ${sortTh('name', 'Project')}
          ${sortTh('totalCost', 'Cost')}
          ${sortTh('sessions', 'Sessions')}
          ${withTokens ? sortTh('totalTokens', 'Tokens') : ''}
          ${sortTh('lastActive', 'Last Active')}
          <th>Model</th>
        </tr></thead>
        <tbody>
          ${[...rows]
            .sort((a, b) => sortCompare(a, b, sort.field, sort.order))
            .map(
              (p) => `
            <tr data-clickable data-key="${esc(p.projectDir)}" onclick="navigateToSessions('${escAttrJs(p.projectDir)}','${escAttrJs(p.name)}')">
              <td title="${esc(p.cwd)}">${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessions}</td>
              ${withTokens ? `<td>${formatTokens(p.totalTokens)}</td>` : ''}
              <td class="muted">${timeAgo(p.lastActive)}</td>
              <td><span class="model-badge">${esc(shortModel(p.primaryModel))}</span></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
}

function focusPreviousRow(view) {
  const key = view === 'sessions' ? lastSelectedSession : view === 'overview' || view === 'projects' ? lastSelectedProject : null;
  if (!key) return;
  const selector = `tr[data-key="${CSS.escape(key)}"]`;
  requestAnimationFrame(() => {
    const rows = getVisibleRows();
    const idx = rows.findIndex((r) => r.matches(selector));
    selectRow(idx >= 0 ? idx : 0);
  });
}

// #endregion

// #region URL_STATE

const TOP_VIEWS = ['overview', 'insights', 'projects'];

function getUrlState() {
  let p = new URLSearchParams(window.location.search);
  if (!p.has('view') && !p.has('session') && !p.has('project')) {
    const saved = storageGet('sessionStorage', 'pi-cost:nav');
    if (saved) p = new URLSearchParams(saved);
  }
  return {
    view: p.get('view') || 'overview',
    project: p.get('project'),
    projectName: p.get('projectName'),
    session: p.get('session'),
    parentView: p.get('parentView') || 'projects',
  };
}

const DEFAULT_RANGE_PRESET = '3';

function presetRange(value) {
  return { kind: 'preset', value: String(value) };
}

function presetDef(value) {
  return RANGE_PRESETS.find((p) => p.value === String(value));
}

function isPresetValue(v) {
  return !!presetDef(v);
}

function isCustomRange(r) {
  return r?.kind === 'custom';
}

// The old '1 day' preset meant a rolling day, which is now '24h'.
function migrateStoredPreset(value) {
  const s = String(value);
  return s === '1' ? '24h' : s;
}

// Reads the JSON tagged union and the legacy bare "3" / "today" scalar that predates it.
function parseStoredRange(raw) {
  if (!raw) return null;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    v = raw;
  }
  if (v?.kind === 'custom') {
    return ISO_DATE_RE.test(v.from) && ISO_DATE_RE.test(v.to) && v.from <= v.to
      ? { kind: 'custom', from: v.from, to: v.to }
      : null;
  }
  const s = migrateStoredPreset(v?.kind === 'preset' ? v.value : v);
  return isPresetValue(s) ? presetRange(s) : null;
}

function loadDateRange() {
  return parseStoredRange(storageGet('localStorage', 'pi-cost:range')) || presetRange(DEFAULT_RANGE_PRESET);
}

function saveDateRange(val) {
  storageSet('localStorage', 'pi-cost:range', JSON.stringify(val));
}

// The range reaches the labels either as the client's tagged union or as the shape the server
// echoes on the session detail payload: 'today', '24h', N days, null for all time, or { from, to }.
function normalizeRange(r) {
  if (r == null) return null;
  if (typeof r === 'object') {
    if (r.kind === 'preset' && isPresetValue(r.value)) return presetRange(r.value);
    if (r.from && r.to) return { kind: 'custom', from: r.from, to: r.to };
    return null;
  }
  if (isPresetValue(r)) return presetRange(r);
  if (String(r) === '1') return presetRange('today');
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? presetRange(n) : null;
}

function rangeSpanLabel(r) {
  return r.from === r.to ? isoDayLabel(r.to) : `${isoDayLabel(r.from)} - ${isoDayLabel(r.to)}`;
}

// One classification (all time, custom window, today, rolling preset) with one phrase per class.
function rangeText(r, prefix = {}) {
  const n = normalizeRange(r);
  const kind = !n ? 'all' : n.kind === 'custom' ? 'custom' : n.value === 'today' ? 'today' : 'rolling';
  const base =
    kind === 'all'
      ? 'all time'
      : kind === 'custom'
        ? rangeSpanLabel(n)
        : kind === 'today'
          ? 'today'
          : n.value === '24h'
            ? '24 hours'
            : `${n.value} days`;
  return (prefix[kind] || '') + base;
}

const rangeLabel = (r) => rangeText(r);
const rangeScopeLabel = (r) => rangeText(r, { rolling: 'last ' });
const rangeInLabel = (r) => rangeText(r, { all: 'in ', custom: 'in ', rolling: 'in the last ' });

const rangeTriggerLabel = (r) => {
  const n = normalizeRange(r) || presetRange(DEFAULT_RANGE_PRESET);
  if (n.kind === 'custom') return rangeSpanLabel(n);
  const def = presetDef(n.value);
  return (def ? def.label : rangeText(n)).toUpperCase();
};

const rangeCardLabel = (r) => {
  const n = normalizeRange(r);
  if (!n) return 'All Time';
  if (n.kind === 'custom') return rangeSpanLabel(n);
  const def = presetDef(n.value);
  return def ? def.cardLabel || def.label : `${n.value} Days`;
};

// The window card would duplicate the Today card, so it is dropped.
function isTodayOnlyRange(r) {
  const n = normalizeRange(r);
  if (!n) return false;
  return n.kind === 'custom' ? n.from === n.to && n.to === todayIso() : n.value === 'today';
}

function loadSort() {
  for (const view of Object.keys(DEFAULT_SORT)) {
    const raw = storageGet('localStorage', `pi-cost:sort:${view}`);
    if (!raw) continue;
    try {
      const { field, order } = JSON.parse(raw);
      if (field) viewSort[view].field = field;
      if (order) viewSort[view].order = order;
    } catch {}
  }
}

function saveSort() {
  storageSet('localStorage', `pi-cost:sort:${currentView}`, JSON.stringify(currentSort()));
}

function updateUrl(mode = 'push') {
  const p = new URLSearchParams();
  if (currentView !== 'overview') p.set('view', currentView);
  if (currentProjectDir) p.set('project', currentProjectDir);
  if (currentProjectName) p.set('projectName', currentProjectName);
  if (currentSessionId) p.set('session', currentSessionId);
  if (parentView !== 'projects') p.set('parentView', parentView);
  if (EMBED) p.set('embed', '1');
  const qs = p.toString();
  const url = qs ? `?${qs}` : '/';
  const sameAsCurrent = (location.search || '') === (qs ? `?${qs}` : '');
  const method = mode === 'push' && !sameAsCurrent ? 'pushState' : 'replaceState';
  history[method](null, '', url);
  storageSet('sessionStorage', 'pi-cost:nav', qs);
}

// #endregion

// #region FETCH

const BROWSER_CACHE_TTL = 60 * 1000;
const MAX_CACHE_ENTRIES = 20;
let forceRefresh = false;
// Age of the data on screen, for the auto-refresh check. A cache hit carries its own timestamp.
let dataFetchedAt = 0;

// In memory on purpose: a restarted server may read another agent dir, and a cache that outlives
// the page would keep showing the old dir's data. The server's 30 s cache absorbs reload cost.
const dataCache = new Map();
const pendingFetches = new Map();

function getCached(key) {
  if (forceRefresh) return null;
  const hit = dataCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > BROWSER_CACHE_TTL) {
    dataCache.delete(key);
    return null;
  }
  dataFetchedAt = Math.max(dataFetchedAt, hit.ts);
  return hit.data;
}

function cacheData(key, data) {
  dataCache.delete(key);
  dataCache.set(key, { data, ts: Date.now() });
  if (dataCache.size > MAX_CACHE_ENTRIES) dataCache.delete(dataCache.keys().next().value);
}

// A re-render can ask for a URL whose first request is still in flight (the board's theme message
// arrives during the first load), so it joins that request.
async function fetchJSON(url, skipCache) {
  if (skipCache) return requestJSON(url);
  const cached = getCached(url);
  if (cached) return cached;
  const pending = pendingFetches.get(url);
  if (pending) return pending;
  const request = requestJSON(url);
  pendingFetches.set(url, request);
  try {
    const data = await request;
    cacheData(url, data);
    return data;
  } finally {
    pendingFetches.delete(url);
  }
}

async function requestJSON(url) {
  const res = await fetch(url, forceRefresh ? { cache: 'reload' } : undefined);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  dataFetchedAt = Date.now();
  return data;
}

// A custom window sends its two local dates; presets stay on the rolling `range` param.
function rangeParams(r = dateRange) {
  return isCustomRange(r) ? `from=${r.from}&to=${r.to}` : `range=${encodeURIComponent(r.value)}`;
}

async function fetchOverview() {
  overviewData = await fetchJSON(`/api/overview?${rangeParams()}`);
}

async function fetchInsights() {
  insightsData = await fetchJSON(`/api/insights?${rangeParams()}`);
}

async function fetchProjects() {
  const data = await fetchJSON(`/api/projects?${rangeParams()}`);
  projectsData = data.projects;
}

async function fetchSessions(projectDir) {
  const data = await fetchJSON(`/api/projects/${encodeURIComponent(projectDir)}/sessions?${rangeParams()}`, true);
  sessionsData = data.sessions || [];
  sessionsCostSeries = data.costSeries || null;
  sessionsModelDistribution = data.modelDistribution || [];
}

async function fetchSessionDetail(sessionId) {
  sessionDetailData = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}?${rangeParams()}`, true);
  if (sessionDetailData && !currentProjectDir) {
    currentProjectDir = sessionDetailData.projectDir;
    currentProjectName = sessionDetailData.cwd;
  }
}

// #endregion

// #region LOADING

let booted = false;
const SKEL_BARS = [35, 60, 45, 80, 55, 70, 40, 90, 65, 50, 75, 30];

function skeletonHtml(view) {
  const line = '<span class="skel"></span>';
  const cards = `<div class="cards-row">${'<div class="stat-card"><span class="skel card-label"></span><span class="skel card-value"></span><span class="skel card-sub"></span></div>'.repeat(4)}</div>`;
  const plot = SKEL_BARS.map((h) => `<span class="skel" style="--h:${h}%"></span>`).join('');
  const chartsRow = `<div class="charts-row">
    <div class="chart-box"><span class="skel chart-title"></span><div class="skel-plot">${plot}</div></div>
    <div class="chart-box"><span class="skel chart-title"></span><div class="skel-donut"></div></div>
  </div>`;
  const table = `<div class="skel-table">${`<div>${line.repeat(4)}</div>`.repeat(6)}</div>`;
  const head = TOP_VIEWS.includes(view) ? '' : `<div class="breadcrumb">${line}</div>`;
  const body = view === 'sessions' || view === 'projects' ? chartsRow + table : cards + chartsRow + table;
  // The first JS skeleton replaces the static one from index.html; fading it in again would blink.
  const fade = booted ? ' skeleton-fade' : '';
  return `<div class="dashboard-content skeleton${esc(fade)}" aria-busy="true" aria-label="Loading">${head}${body}</div>`;
}

// #endregion

// #region RENDER_OVERVIEW

function renderOverview() {
  const el = document.getElementById('overview-view');
  if (!el) return;
  if (!overviewData) {
    el.innerHTML = skeletonHtml('overview');
    return;
  }

  const s = overviewData.summary;
  const h = JSON.stringify({ overviewData, sort: viewSort.overview });
  if (lastRenderHash.overview === h) return;
  lastRenderHash.overview = h;

  const costSeries = overviewData.costSeries;
  const models = overviewData.modelDistribution || [];
  const projects = overviewData.projects || [];
  const meta = overviewData.pricingMeta || {};
  const sc = s.sourceCounts || {};
  const totalRows = (sc.jsonl || 0) + (sc.pricing || 0) + (sc.none || 0);
  const pctEst = totalRows ? Math.round(((sc.pricing || 0) / totalRows) * 100) : 0;
  // null, not 0, when nothing cacheable ran: an empty range shows no meter at all.
  const cachePct = s.totalCacheRead + s.totalCacheWrite > 0 ? s.cacheEfficiency * 100 : null;

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="cards-row">
        ${
          // null when the window ends before today: a zero would read as "nothing spent today".
          s.todayCost == null
            ? ''
            : `
        <div class="stat-card">
          <div class="card-label">Today</div>
          <div class="card-value cost">${formatCost(s.todayCost)}</div>
        </div>`
        }
        ${
          isTodayOnlyRange(dateRange)
            ? ''
            : `
        <div class="stat-card">
          <div class="card-label">${esc(rangeCardLabel(dateRange))}</div>
          <div class="card-value cost">${formatCost(s.totalCost)}</div>
        </div>`
        }
        <div class="stat-card">
          <div class="card-label">Sessions</div>
          <div class="card-value">${s.totalSessions}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Tokens</div>
          <div class="card-value">${formatTokens(s.totalInput + s.totalOutput)}</div>
          <div class="card-sub">In: ${formatTokens(s.totalInput)} / Out: ${formatTokens(s.totalOutput)}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Cache</div>
          <div class="card-value">${cachePct == null ? '0.0' : cachePct.toFixed(1)}%</div>
          ${cachePct == null ? '' : meter(cachePct, { ariaLabel: `${cachePct.toFixed(1)}% of all input tokens were served from cache` })}
          <div class="card-sub">Read: <strong>${formatTokens(s.totalCacheRead)}</strong> / Write: ${formatTokens(s.totalCacheWrite)}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Cost Source</div>
          <div class="card-value" style="font-size:14px">
            ${srcBadge('jsonl')} ${sc.jsonl || 0}
            &nbsp;${srcBadge('pricing')} ${sc.pricing || 0}
          </div>
          <div class="card-sub">${pctEst}% estimated &middot; ${esc(meta.source || 'none')}</div>
        </div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <div class="chart-title">${costSeriesTitle(costSeries)}</div>
          <canvas id="costChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Cost by Model</div>
          <canvas id="modelChart"></canvas>
        </div>
      </div>

      ${
        projects.length
          ? `
      <div class="section-title">Projects</div>
      ${projectsTable(projects, viewSort.overview, false)}`
          : `<div class="empty-state"><div>No usage ${esc(rangeInLabel(dateRange))}</div></div>`
      }
    </div>`;

  requestAnimationFrame(() => {
    renderCostChart(costSeries, 'costChart', 'cost', models);
    renderModelChart(models);
  });
}

// #endregion

// #region RENDER_INSIGHTS

const HEATMAP_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Columns start at 6 AM so the workday sits left of center instead of the dead early hours.
const HEATMAP_START_HOUR = 6;

function heatmapDayLabel(dateStr) {
  const [y, m, d] = isoParts(dateStr);
  return `${HEATMAP_DAYS[new Date(y, m - 1, d).getDay()]} ${d}`;
}

function ampm(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// Post-midnight columns sit at each row's tail and read from the next calendar day: the night
// belongs to the evening it continues.
function buildHeatmap(hm, days, today) {
  const rowCosts = hm.map((row, d) => [
    ...row.slice(HEATMAP_START_HOUR),
    ...(hm[d + 1] ? hm[d + 1].slice(0, HEATMAP_START_HOUR) : new Array(HEATMAP_START_HOUR).fill(0)),
  ]);
  const max = rowCosts.reduce((m, row) => Math.max(m, ...row), 0);
  if (max === 0) return '<div class="empty-state"><div>No activity in this range</div></div>';
  const labels = days.map(heatmapDayLabel);
  const hourAt = (col) => (col + HEATMAP_START_HOUR) % 24;
  const hours = Array.from(
    { length: 24 },
    (_, col) => `<span class="hm-hour">${hourAt(col) % 3 === 0 ? ampm(hourAt(col)) : ''}</span>`,
  ).join('');
  const rows = hm
    .map((_, d) => {
      const label = labels[d];
      return `
    <div class="hm-row${days[d] === today ? ' hm-today' : ''}">
      <span class="hm-day">${esc(label)}</span>
      ${rowCosts[d]
        .map((cost, col) => {
          const h = hourAt(col);
          const day = h < HEATMAP_START_HOUR ? (labels[d + 1] ?? label) : label;
          return `
        <span class="hm-cell" data-hm="${esc(`${day}|${h}|${cost}`)}">
          <i style="opacity:${cost > 0 ? Math.max(0.12, cost / max).toFixed(2) : 0}"></i>
        </span>`;
        })
        .join('')}
    </div>`;
    })
    .join('');
  return `<div class="heatmap">${rows}<div class="hm-row"><span class="hm-day"></span>${hours}</div></div>`;
}

let hmTipEl = null;
function initHeatmapTooltip() {
  if (hmTipEl) return;
  hmTipEl = document.createElement('div');
  hmTipEl.className = 'hm-tip';
  document.body.appendChild(hmTipEl);
  document.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.hm-cell[data-hm]');
    if (!cell) {
      hmTipEl.classList.remove('on');
      return;
    }
    const [day, h, cost] = cell.dataset.hm.split('|');
    hmTipEl.innerHTML = `<b>${formatCost(+cost)}</b><span>${esc(day)} ${ampm(+h)}&ndash;${ampm((+h + 1) % 24)}</span>`;
    hmTipEl.classList.add('on');
    const r = cell.getBoundingClientRect();
    const tr = hmTipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
    const top = r.top - tr.height - 6;
    hmTipEl.style.left = `${left}px`;
    hmTipEl.style.top = `${top < 4 ? r.bottom + 6 : top}px`;
  });
}

function blockSpanLabel(b) {
  const opts = { month: 'short', day: 'numeric', hour: 'numeric' };
  return `${stripNarrowSpace(new Date(b.start).toLocaleString(undefined, opts))} – ${localTime(b.end, { hour: 'numeric' })}`;
}

// pi records no plan limits, so a block is only open (its 5 h window has not ended) or ended.
function blockStatus(b) {
  const left = (new Date(b.end) - Date.now()) / 60000;
  return left > 0
    ? `<span class="block-badge active">open &middot; ${formatDuration(left)} left</span>`
    : `<span class="block-badge">ended ${timeAgo(b.lastActivity)}</span>`;
}

function renderInsights() {
  const el = document.getElementById('insights-view');
  if (!el) return;
  if (!insightsData) {
    el.innerHTML = skeletonHtml('insights');
    return;
  }

  const d = insightsData;
  const h = JSON.stringify(d);
  if (lastRenderHash.insights === h) return;
  lastRenderHash.insights = h;

  const sub = d.subagents;
  const agentTotal = sub.mainCost + sub.subagentCost;
  const subPct = formatPct(sub.subagentCost, agentTotal);
  const cacheHitPct = d.tokens.cacheRead + d.tokens.cacheWrite > 0 ? Math.round(d.cacheEfficiency * 100) : null;
  const comp = d.compactions || { count: 0, totalCost: 0, tokensBefore: 0 };
  const showWeekly = d.weekly.length >= 3;
  const heatSpan = d.heatmapDays.length
    ? `${isoDayLabel(d.heatmapDays[0])} &rarr; ${isoDayLabel(d.heatmapDays[d.heatmapDays.length - 1])}`
    : '';

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="cards-row">
        <div class="stat-card">
          <div class="card-label">Monthly Run-Rate</div>
          <div class="card-value cost">${formatCost(d.runRate.projectedMonthly)}</div>
          <div class="card-sub"><strong>${formatCost(d.runRate.dailyAvg)}/day</strong> over ${d.runRate.days} ${d.runRate.days === 1 ? 'day' : 'days'}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Cache Savings</div>
          <div class="card-value cost">${formatCost(d.cacheSavings)}</div>
          ${cacheHitPct == null ? '' : meter(cacheHitPct, { label: `${cacheHitPct}% hit`, ariaLabel: `${cacheHitPct}% of input was served from cache` })}
          <div class="card-sub">vs. uncached input &middot; <strong>${formatTokens(d.tokens.cacheRead)}</strong> reads</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Subagent Share</div>
          <div class="card-value">${subPct}%</div>
          ${agentTotal > 0 ? meter(subPct, { ariaLabel: `subagents are ${subPct}% of ${formatCost(agentTotal)}` }) : ''}
          <div class="card-sub"><strong>${formatCost(sub.subagentCost)}</strong> of ${formatCost(agentTotal)} &middot; ${sub.runs} ${sub.runs === 1 ? 'run' : 'runs'}</div>
        </div>
        <div class="stat-card">
          <div class="card-label">Compactions</div>
          <div class="card-value">${comp.count}</div>
          <div class="card-sub">summarizer <strong>${formatCost(comp.totalCost)}</strong> &middot; ${formatTokens(comp.tokensBefore)} tokens replaced</div>
        </div>
      </div>

      <div class="charts-row">
        <div class="chart-box">
          <div class="chart-title">Token Composition <span class="chart-title-note">log scale</span></div>
          <canvas id="tokenSplitChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Top Tools</div>
          ${d.tools.length ? '<canvas id="toolsChart"></canvas>' : '<div class="card-sub">No tool calls in this range</div>'}
        </div>
      </div>

      <div class="charts-row${showWeekly ? '' : ' single'}">
        <div class="chart-box">
          <div class="chart-title">Activity Heatmap (cost by hour) <span class="chart-title-note">${heatSpan}</span></div>
          ${buildHeatmap(d.heatmap, d.heatmapDays, d.heatmapToday)}
        </div>
        ${
          showWeekly
            ? `
        <div class="chart-box">
          <div class="chart-title">Weekly Cost</div>
          <canvas id="weeklyChart"></canvas>
        </div>`
            : ''
        }
      </div>

      ${
        d.blocks.length
          ? `
      <div class="section-title">5-Hour Blocks</div>
      <table class="data-table">
        <thead><tr>
          <th>Block</th><th>Status</th><th>Messages</th><th>Tokens</th><th>Cost</th><th>Models</th>
        </tr></thead>
        <tbody>
          ${d.blocks
            .map(
              (b) => `
            <tr>
              <td>${blockSpanLabel(b)}</td>
              <td>${blockStatus(b)}</td>
              <td>${b.messageCount}</td>
              <td>${formatTokens(b.tokens)}</td>
              <td class="cost-cell">${formatCost(b.cost)}</td>
              <td>${b.models.map((m) => `<span class="model-badge">${esc(shortModel(m))}</span>`).join(' ')}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
          : ''
      }
    </div>`;

  initHeatmapTooltip();
  requestAnimationFrame(() => {
    renderTokenSplitChart(d.tokens);
    if (d.tools.length) renderToolsChart(d.tools);
    if (showWeekly) renderWeeklyChart(d.weekly);
  });
}

// #endregion

// #region RENDER_PROJECTS

function renderProjects() {
  const el = document.getElementById('projects-view');
  if (!el) return;
  if (!projectsData) {
    el.innerHTML = skeletonHtml('projects');
    return;
  }

  const h = JSON.stringify({ projectsData, sort: viewSort.projects });
  if (lastRenderHash.projects === h) return;
  lastRenderHash.projects = h;

  if (projectsData.length === 0) {
    el.innerHTML = `<div class="dashboard-content"><div class="empty-state">
      <div class="empty-icon">$</div>
      <div>No project data ${esc(rangeInLabel(dateRange))}</div>
      <div>pi-cost reads the sessions dir under the pi agent dir (PI_CODING_AGENT_DIR, default ~/.pi/agent).</div>
    </div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="section-title">All Projects</div>
      ${projectsTable(projectsData, viewSort.projects, true)}
    </div>`;
}

// #endregion

// #region RENDER_SESSIONS

function sessionBreadcrumb() {
  return `<div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <span class="current" title="${esc(currentProjectName || '')}">${esc(basename(currentProjectName) || 'Project')}</span>
      </div>`;
}

function renderSessions() {
  const el = document.getElementById('sessions-view');
  if (!el) return;
  if (!sessionsData) {
    el.innerHTML = skeletonHtml('sessions');
    return;
  }

  const h = JSON.stringify({ sessionsData, sessionsCostSeries, sessionsModelDistribution, sort: viewSort.sessions });
  if (lastRenderHash.sessions === h) return;
  lastRenderHash.sessions = h;

  if (sessionsData.length === 0) {
    el.innerHTML = `<div class="dashboard-content">
      ${sessionBreadcrumb()}
      <div class="empty-state"><div>No sessions for this project ${esc(rangeInLabel(dateRange))}</div></div>
    </div>`;
    return;
  }

  const total = sessionsData.reduce((s, x) => s + (x.totalCost || 0), 0);

  el.innerHTML = `
    <div class="dashboard-content">
      ${sessionBreadcrumb()}
      <div class="charts-row with-aside">
        <div class="chart-box">
          <div class="chart-title">${costSeriesTitle(sessionsCostSeries)}</div>
          <canvas id="sessionsCostChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Cost by Model</div>
          <canvas id="sessionsModelChart"></canvas>
        </div>
        <div class="chart-box" style="display:flex;flex-direction:column;justify-content:center;align-items:center;min-width:120px">
          <div class="chart-title">Total Cost</div>
          <div style="font-size:22px;font-weight:700;color:var(--accent)">${formatCost(total)}</div>
          <div style="color:var(--text-tertiary);font-size:12px;margin-top:4px">${sessionsData.length} sessions</div>
        </div>
      </div>

      <table class="data-table">
        <thead><tr>
          ${sortTh('customTitle', 'Session')}
          ${sortTh('totalCost', 'Cost')}
          ${sortTh('totalTokens', 'Tokens')}
          ${sortTh('messageCount', 'Msgs')}
          ${sortTh('durationMinutes', 'Duration')}
          <th>Provider</th>
          <th>Model</th>
          ${sortTh('lastTimestamp', 'Last Active')}
        </tr></thead>
        <tbody>
          ${[...sessionsData]
            .sort((a, b) => sortCompare(a, b, viewSort.sessions.field, viewSort.sessions.order))
            .map(sessionRow)
            .join('')}
        </tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    renderCostChart(sessionsCostSeries, 'sessionsCostChart', 'sessionsCost', sessionsModelDistribution);
    renderModelChart(sessionsModelDistribution, 'sessionsModelChart', 'sessionsModel');
  });
}

function sessionRow(s) {
  const label = s.customTitle || shortId(s.id);
  const preview = s.firstUserText ? s.firstUserText.slice(0, 60) : '';
  const more = s.firstUserText && s.firstUserText.length > 60 ? '…' : '';
  const title = preview ? `${s.id} — ${s.firstUserText}` : s.id;
  const c = s.compactions;
  const compactTag = c?.count
    ? ` <span class="compaction-tag" title="${esc(`${c.count} compaction(s), ${formatCost(c.totalCost)}`)}">${c.count}&times; compact</span>`
    : '';
  // Nested subagent runs never reach the lists, so a listed row with a parent is a fork.
  const subTag = s.parentSession ? ' <span class="subagent-tag" title="Forked from another session">fork</span>' : '';
  const childTag = s.subagentCount
    ? ` <span class="subagent-tag" title="${esc(`${s.subagentCount} spawned subagent(s) totaling ${formatCost(s.subagentCost)}`)}">+${s.subagentCount}</span>`
    : '';
  return `
            <tr data-clickable data-key="${esc(s.id)}" onclick="navigateToDetail('${escAttrJs(s.id)}')">
              <td class="truncate" title="${esc(title)}"><code class="session-id">${esc(label)}</code>${preview ? ` <span class="muted">${esc(preview)}${more}</span>` : ''}${subTag}${childTag}</td>
              <td class="cost-cell">${formatCost(s.totalCost)}</td>
              <td>${formatTokens(s.totalTokens)}</td>
              <td>${s.messageCount}${compactTag}</td>
              <td class="muted">${formatDuration(s.durationMinutes)}</td>
              <td class="muted">${esc(s.provider || '')}</td>
              <td><span class="model-badge">${esc(shortModel(s.primaryModel || s.model))}</span></td>
              <td class="muted">${timeAgo(s.lastTimestamp)}</td>
            </tr>`;
}

// #endregion

// #region RENDER_DETAIL

function renderDetail() {
  const el = document.getElementById('detail-view');
  if (!el) return;
  if (!sessionDetailData) {
    el.innerHTML = skeletonHtml('detail');
    return;
  }

  const d = sessionDetailData;
  const h = JSON.stringify(d);
  if (lastRenderHash.detail === h) return;
  lastRenderHash.detail = h;

  const projectDir = d.projectDir || currentProjectDir;
  const projectCwd = d.cwd || currentProjectName || projectDir;
  const projectName = basename(projectCwd);
  const sc = d.sourceCounts || {};
  const hasSubagents = d.messages.some((m) => m.subagent);
  const parentLink = d.parent
    ? `<a class="truncate" onclick="navigateToDetail('${escAttrJs(d.parent.id)}')" title="${esc(d.parent.title || d.parent.id)}">${esc(d.parent.title || shortId(d.parent.id))}</a>
        <span class="sep">/</span>`
    : '';

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <a onclick="navigateToSessions('${escAttrJs(projectDir)}','${escAttrJs(projectName)}')" title="${esc(projectCwd)}">${esc(projectName)}</a>
        <span class="sep">/</span>
        ${parentLink}
        <span class="current" title="${esc(d.id || '')}"><code class="session-id">${esc(d.customTitle || shortId(d.id))}</code></span>
      </div>

      <div class="detail-header">
        <div class="detail-stat">
          <div class="detail-label">Total Cost</div>
          <div class="detail-value cost">${formatCost(d.totalCost)}<span class="detail-label detail-scope">all time</span></div>
          ${d.subagentCount ? `<div class="detail-sub">incl. <strong>${formatCost(d.subagentCost)}</strong> in ${d.subagentCount} subagent ${d.subagentCount === 1 ? 'run' : 'runs'}</div>` : ''}
        </div>
        <div class="detail-stat">
          <div class="detail-label">Input</div>
          <div class="detail-value">${formatTokens(d.input)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Output</div>
          <div class="detail-value">${formatTokens(d.output)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Cache Write</div>
          <div class="detail-value">${formatTokens(d.cacheWrite)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Cache Read</div>
          <div class="detail-value">${formatTokens(d.cacheRead)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Messages</div>
          <div class="detail-value">${d.messages.length}<span class="detail-label detail-scope">all time</span></div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Models</div>
          <div class="detail-value">${esc((d.models || []).map(shortModel).filter(Boolean).join(', ') || '—')}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Source</div>
          <div class="detail-value" style="font-size:12px">
            ${srcBadge('jsonl')} ${sc.jsonl || 0}
            &nbsp;${srcBadge('pricing')} ${sc.pricing || 0}
          </div>
        </div>
        ${compactionStat(d)}
      </div>

      ${detailRangeNote(d)}
      ${compactionNote(d)}

      <div class="charts-row${hasSubagents ? ' with-share' : ''}" style="margin-bottom:20px">
        <div class="chart-box">
          <div class="chart-title">Cumulative Cost</div>
          <canvas id="cumulativeChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Token Breakdown per Message</div>
          <canvas id="tokenBreakdownChart"></canvas>
        </div>
        ${
          hasSubagents
            ? `<div class="chart-box">
          <div class="chart-title">Subagent Share</div>
          <div class="share-body">
            <div class="share-pie"><canvas id="subagentShareChart"></canvas></div>
            <ul class="share-legend" id="subagentShareLegend"></ul>
          </div>
        </div>`
            : ''
        }
      </div>

      ${childSessionsSection(d)}

      ${rangeBrushHtml(d.messages.length)}

      <div class="section-title" id="messagesTitle"></div>
      <table class="messages-table">
        <thead><tr>
          <th>#</th>
          <th>Time</th>
          <th>Model</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache W.</th>
          <th>Cache R.</th>
          <th>Cost</th>
          <th>Src</th>
          <th>Cumulative</th>
        </tr></thead>
        <tbody id="messagesBody"></tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    destroyChart('cumulative');
    destroyChart('tokenBreakdown');
    destroyChart('subagentShare');
    const range = detailRangeFor(d);
    applyDetailRange(d.messages, range);
    initRangeBrush(d.messages, range);
  });
}

// The session row that links here is scoped to the active range, so a session older than the
// range would otherwise show larger numbers here with no explanation.
function detailRangeNote(d) {
  const all = d.messages.length;
  const slice = (label, s) =>
    `<span class="scope-label">${esc(label)}</span> <strong>${formatCost(s.totalCost)}</strong> / ${s.messageCount} msg`;
  const worthShowing = (s) => s && s.messageCount > 0 && s.messageCount < all;
  const parts = [];
  if (worthShowing(d.inRange)) parts.push(slice(rangeScopeLabel(d.range), d.inRange));
  if (worthShowing(d.today) && d.today.messageCount !== d.inRange?.messageCount) parts.push(slice('today', d.today));
  if (!parts.length) return '';
  return `<div class="detail-range-note">Totals above are all-time &middot; ${parts.join(' &middot; ')}</div>`;
}

function compactionStat(d) {
  const n = d.compactionEvents?.length || 0;
  if (!n) return '';
  return `<div class="detail-stat">
      <div class="detail-label">Compactions</div>
      <div class="detail-value">${n}<span class="detail-label detail-scope">${formatCost(d.compactions?.totalCost)}</span></div>
    </div>`;
}

// pi records the summarizer call's usage on the compaction entry when it has one, so that cost is
// real and already in the total. pi records no post-compaction size and no auto/manual trigger.
function compactionNote(d) {
  const events = d.compactionEvents || [];
  if (!events.length) return '';
  const tokensBefore = events.reduce((s, e) => s + (e.tokensBefore || 0), 0);
  const billed = d.compactions?.count || 0;
  const hook = events.filter((e) => e.fromHook).length;
  return `<div class="detail-range-note compaction-note">
    <span class="scope-label">compaction</span> ${events.length} ${events.length === 1 ? 'event' : 'events'} &middot;
    replaced <strong>${formatTokens(tokensBefore)}</strong> tokens &middot;
    summarizer <strong>${formatCost(d.compactions?.totalCost)}</strong> (in total${billed < events.length ? `, recorded for ${billed} of ${events.length}` : ''})${hook ? ` &middot; ${hook} from a hook` : ''}
  </div>`;
}

function childSessionsSection(d) {
  if (!d.childSessions?.length) return '';
  return `
      <div class="section-title">Spawned sessions (${d.childSessions.length})</div>
      <table class="data-table" style="margin-bottom:20px">
        <thead><tr><th>Session</th><th>Cost</th><th>Tokens</th><th>Msgs</th><th>Model</th><th>When</th></tr></thead>
        <tbody>
          ${d.childSessions
            .map((sa) => {
              const label = sa.customTitle || shortId(sa.id);
              const preview = sa.firstUserText ? sa.firstUserText.slice(0, 120) : '';
              return `<tr data-clickable onclick="navigateToDetail('${escAttrJs(sa.id)}')">
              <td class="truncate" title="${esc(preview ? `${sa.id} — ${preview}` : sa.id)}"><code class="session-id">${esc(label)}</code>${preview ? ` <span class="muted">${esc(preview)}</span>` : ''}</td>
              <td class="cost-cell">${formatCost(sa.totalCost)}</td>
              <td>${formatTokens(sa.totalTokens)}</td>
              <td>${sa.messageCount}</td>
              <td><span class="model-badge">${esc(shortModel(sa.primaryModel || sa.model))}</span></td>
              <td class="muted">${timeAgo(sa.lastTimestamp)}</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;
}

function renderMessageRows(slice, total) {
  const body = document.getElementById('messagesBody');
  if (!body) return;
  document.getElementById('messagesTitle').textContent =
    slice.length === total ? `Messages (${total})` : `Messages (${slice.length} of ${total})`;
  const rows = [];
  for (let i = slice.length - 1; i >= 0; i--) rows.push(buildMessageRow(slice[i]));
  body.innerHTML = rows.join('');
}

function buildMessageRow(m) {
  const sa = m.subagent;
  const model = `<span class="model-badge">${esc(shortModel(m.model))}</span>`;
  let modelCol;
  let rowAttrs = '';
  if (sa) {
    const task = sa.task ? String(sa.task) : '';
    modelCol = `${model} <span class="subagent-tag">${esc(sa.agent || 'subagent')}</span>${task ? ` <span class="subagent-desc">${esc(task.slice(0, 80))}</span>` : ''}`;
    const tip = `${task || sa.agent || 'subagent'}${sa.turns ? ` · ${sa.turns} turns` : ''}${sa.sessionId ? ' · open subagent session' : ''}`;
    rowAttrs = sa.sessionId
      ? ` class="subagent-row clickable" data-clickable onclick="navigateToDetail('${escAttrJs(sa.sessionId)}')" title="${esc(tip)}"`
      : ` class="subagent-row" title="${esc(tip)}"`;
  } else if (m.compaction) {
    const tip = `compaction · replaced ${formatTokens(m.compaction.tokensBefore)} tokens${m.compaction.fromHook ? ' · from a hook' : ''}`;
    modelCol = `${model} <span class="compaction-tag" title="${esc(tip)}">compact</span>`;
    rowAttrs = ' class="compaction-row"';
  } else {
    const tools = m.tools?.length ? ` ${m.tools.map((t) => `<span class="tool-tag">${esc(t)}</span>`).join(' ')}` : '';
    modelCol = model + tools;
  }
  return `<tr${rowAttrs}>
    <td class="muted">${m.index}</td>
    <td class="muted">${m.ts ? localTime(m.ts) : ''}</td>
    <td>${modelCol}</td>
    <td>${formatTokens(m.input)}</td>
    <td>${formatTokens(m.output)}</td>
    <td>${formatTokens(m.cacheWrite)}</td>
    <td>${formatTokens(m.cacheRead)}</td>
    <td class="cost-cell">${formatCost(m.cost)}</td>
    <td>${srcBadge(m.costSource)}</td>
    <td class="cumulative">${formatCost(m.cumulativeCost)}</td>
  </tr>`;
}

// #endregion

// #region CHARTS

let _chartColors = null;

function getChartColors() {
  return (_chartColors ||= readChartColors());
}

function readChartColors() {
  const style = getComputedStyle(document.body);
  const v = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#e86f33'),
    chartFill: v('--chart-fill', 'rgba(232,111,51,0.6)'),
    text: v('--text-secondary', '#c2c4c9'),
    textPrimary: v('--text-primary', '#f0f1f3'),
    textMuted: v('--text-muted', '#7d808a'),
    mono: v('--mono', "'IBM Plex Mono', monospace"),
    border: v('--border', '#363840'),
    bg: v('--bg-elevated', '#1e2025'),
    chart2: v('--chart-2', '#60a5fa'),
    chart3: v('--chart-3', '#3ecf8e'),
    chart4: v('--chart-4', '#f0b429'),
    chart5: v('--chart-5', '#b784f5'),
    chart6: v('--chart-6', '#fb7185'),
  };
}

// One palette so per-model colors match across charts. It leads with the theme accent, so a
// single-model chart takes the theme's color.
function chartPalette(c) {
  return [c.accent, c.chart2, c.chart3, c.chart4, c.chart5, c.chart6];
}

let colorProbe = null;

// Theme colors come from JSON files and from the board, so they can be hex, rgb() or any CSS
// color. Anything else is resolved through the browser once.
function parseColor(color) {
  const s = String(color || '').trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((ch) => ch + ch).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (rgb) return rgb.slice(1, 4).map(Number);
  if (!s || !CSS.supports('color', s)) return null;
  if (!colorProbe) {
    colorProbe = document.createElement('span');
    colorProbe.style.display = 'none';
    document.body.appendChild(colorProbe);
  }
  colorProbe.style.color = s;
  const resolved = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(getComputedStyle(colorProbe).color);
  return resolved ? resolved.slice(1, 4).map(Number) : null;
}

function withAlpha(color, alpha) {
  const rgb = parseColor(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : color;
}

function messageTooltipTitle(messages, items) {
  const m = messages[items[0]?.dataIndex];
  if (!m) return '';
  return `#${m.index}${m.subagent ? ` · ${m.subagent.agent}` : m.compaction ? ' · compaction' : ''}`;
}

function tokenSeries(c) {
  return [
    ['Input', 'input', c.accent],
    ['Output', 'output', c.chart2],
    ['Cache Write', 'cacheWrite', c.chart3],
    ['Cache Read', 'cacheRead', c.chart4],
  ];
}

function chartDefaults(c = getChartColors()) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      // Mirrors .hm-tip so a chart hover and a heatmap hover read as the same tooltip.
      tooltip: {
        backgroundColor: c.bg,
        titleColor: c.textMuted,
        bodyColor: c.textPrimary,
        borderColor: c.border,
        borderWidth: 1,
        cornerRadius: 4,
        padding: { top: 5, bottom: 5, left: 8, right: 8 },
        titleFont: { family: c.mono, size: 10, weight: 'normal' },
        bodyFont: { family: c.mono, size: 13, weight: '600' },
        titleMarginBottom: 2,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 4,
      },
    },
    scales: {
      x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border, drawBorder: false } },
      y: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border, drawBorder: false } },
    },
  };
}

// Log axes tick at every 2..9 within a decade, which reads as noise. Keep powers of 10 only.
function isDecade(v) {
  const l = Math.log10(v);
  return Math.abs(l - Math.round(l)) < 1e-9;
}

// maxValue caps the axis at the largest bar and labels it.
function logAxis(xDefaults, maxValue) {
  const labeled = (v) => isDecade(v) || v === maxValue;
  return {
    ...xDefaults,
    type: 'logarithmic',
    min: 1,
    ...(maxValue > 1 ? { max: maxValue } : {}),
    afterBuildTicks: (scale) => {
      if (maxValue <= 1) return;
      scale.ticks = scale.ticks.filter(
        (t) => t.value !== maxValue && !(isDecade(t.value) && Math.abs(Math.log10(maxValue / t.value)) < 0.25),
      );
      scale.ticks.push({ value: maxValue });
    },
    grid: {
      ...xDefaults.grid,
      color: (ctx) => (ctx.tick && labeled(ctx.tick.value) ? xDefaults.grid.color : 'transparent'),
    },
    ticks: {
      ...xDefaults.ticks,
      autoSkip: false,
      callback: (v) => (labeled(v) ? formatTokens(v) : ''),
    },
  };
}

function barDataset(data, color) {
  return {
    data,
    backgroundColor: Array.isArray(color) ? color.map((x) => withAlpha(x, 0.5)) : withAlpha(color, 0.5),
    borderColor: color,
    borderWidth: 1.5,
    borderRadius: 3,
  };
}

function withTooltip(defaults, callbacks) {
  return { ...defaults.plugins, tooltip: { ...defaults.plugins.tooltip, callbacks } };
}

// Two significant digits below a cent, so a sub-cent cost does not read as $0.00.
function usd(v) {
  const a = Math.abs(v);
  return `$${v.toFixed(a >= 0.01 || a === 0 ? 2 : Math.min(6, Math.ceil(-Math.log10(a)) + 1))}`;
}

// Ticks share the decimals their step needs, so neighbouring labels stay distinct.
function usdTick(v, _i, ticks) {
  const step = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0;
  let d = 2;
  while (d < 6 && step > 0 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6) d++;
  return `$${v.toFixed(d)}`;
}

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function renderCostChart(series, canvasId, chartKey, distribution = []) {
  const points = series?.points;
  const canvas = document.getElementById(canvasId);
  if (!canvas || !points?.length) return;
  destroyChart(chartKey);

  const c = getChartColors();
  const defaults = chartDefaults(c);

  // Stack order follows modelDistribution so segment colors match the Cost by Model chart.
  const present = new Set();
  for (const p of points) {
    for (const m in p.byModel) if (p.byModel[m] > 0) present.add(m);
  }
  const models = distribution.filter((d) => present.has(d.model)).map((d) => d.model);
  for (const m of present) if (!models.includes(m)) models.push(m);
  const palette = chartPalette(c);

  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: points.map((p) => bucketLabel(p.key, series.bucket)),
      datasets: models.map((m, i) => ({
        label: shortModel(m),
        data: points.map((p) => p.byModel?.[m] || 0),
        backgroundColor: withAlpha(palette[i % palette.length], 0.5),
        borderColor: palette[i % palette.length],
        borderWidth: 1.5,
        borderRadius: 2,
        stack: 'cost',
      })),
    },
    options: {
      ...defaults,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        ...withTooltip(defaults, { label: (ctx) => `${ctx.dataset.label}  ${usd(ctx.parsed.y)}` }),
        legend: {
          display: models.length > 1,
          position: 'bottom',
          labels: { color: c.text, font: { size: 9 }, boxWidth: 8, boxHeight: 8 },
        },
      },
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, stacked: true },
        y: { ...defaults.scales.y, stacked: true, ticks: { ...defaults.scales.y.ticks, callback: usdTick } },
      },
    },
  });
}

function renderModelChart(models, canvasId = 'modelChart', chartKey = 'model') {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !models?.length) return;
  destroyChart(chartKey);

  const c = getChartColors();
  const palette = chartPalette(c);
  const defaults = chartDefaults(c);
  const total = models.reduce((s, m) => s + m.cost, 0);

  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: models.map((m) => shortModel(m.model)),
      datasets: [
        barDataset(
          models.map((m) => m.cost),
          models.map((_, i) => palette[i % palette.length]),
        ),
      ],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      interaction: { mode: 'nearest', intersect: true },
      plugins: withTooltip(defaults, { label: (ctx) => `${usd(ctx.parsed.x)} (${formatPct(ctx.parsed.x, total)}%)` }),
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, ticks: { ...defaults.scales.x.ticks, callback: usdTick } },
      },
    },
  });
}

function cumulativeChartData(messages, c) {
  const small = messages.length <= 50;
  return {
    labels: messages.map((m) => m.index),
    datasets: [
      {
        label: 'Cumulative Cost',
        data: messages.map((m) => m.cumulativeCost),
        borderColor: c.accent,
        backgroundColor: c.chartFill,
        fill: true,
        borderWidth: 2,
        pointRadius: small ? 3 : 0,
        // Subagent points render hollow so they read as folded-in cost, not main-loop turns.
        pointBackgroundColor: small ? messages.map((m) => (m.subagent ? c.bg : c.accent)) : c.accent,
        pointBorderColor: c.accent,
        tension: 0.2,
      },
    ],
  };
}

function tokenBreakdownChartData(messages, c) {
  const barColors = (color) => {
    const faded = withAlpha(color, 0.45);
    return messages.map((m) => (m.subagent ? faded : color));
  };
  return {
    labels: messages.map((m) => m.index),
    datasets: tokenSeries(c).map(([label, key, color]) => ({
      label,
      data: messages.map((m) => m[key]),
      backgroundColor: barColors(color),
      borderRadius: 2,
    })),
  };
}

// A dashed vertical line before each compaction row. Reads chart.$compactions, set by
// markCompactions, so a draw costs no style lookup or scan.
const compactionMarkers = {
  id: 'compactionMarkers',
  afterDatasetsDraw(chart) {
    const marks = chart.$compactions;
    if (!marks?.indices.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.strokeStyle = marks.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.font = `9px ${marks.font}`;
    ctx.fillStyle = marks.color;
    ctx.textAlign = 'center';
    for (const i of marks.indices) {
      const p = scales.x.getPixelForValue(i);
      const x = i > 0 ? (p + scales.x.getPixelForValue(i - 1)) / 2 : p;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.fillText('compact', x, chartArea.top - 2);
    }
    ctx.restore();
  },
};

function markCompactions(chart, messages, c) {
  chart.$compactions = {
    indices: messages.flatMap((m, i) => (m.compaction ? [i] : [])),
    color: c.chart5,
    font: c.mono,
  };
}

function renderCumulativeChart(messages) {
  const canvas = document.getElementById('cumulativeChart');
  if (!canvas || !messages?.length) return;
  destroyChart('cumulative');

  const c = getChartColors();
  const defaults = chartDefaults(c);

  charts.cumulative = new Chart(canvas, {
    type: 'line',
    data: cumulativeChartData(messages, c),
    plugins: [compactionMarkers],
    options: {
      ...defaults,
      plugins: withTooltip(defaults, {
        title: (items) => messageTooltipTitle(detailSlice, items),
        label: (ctx) => usd(ctx.parsed.y),
      }),
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, title: { display: true, text: 'Message #', color: c.text, font: { size: 10 } } },
        y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, callback: usdTick } },
      },
    },
  });
  markCompactions(charts.cumulative, messages, c);
}

function renderTokenBreakdownChart(messages) {
  const canvas = document.getElementById('tokenBreakdownChart');
  if (!canvas || !messages?.length) return;
  destroyChart('tokenBreakdown');

  const c = getChartColors();
  const defaults = chartDefaults(c);

  charts.tokenBreakdown = new Chart(canvas, {
    type: 'bar',
    data: tokenBreakdownChartData(messages, c),
    plugins: [compactionMarkers],
    options: {
      ...defaults,
      plugins: {
        ...withTooltip(defaults, { title: (items) => messageTooltipTitle(detailSlice, items) }),
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: c.text, font: { size: 10, family: c.mono }, padding: 8, boxWidth: 12, boxHeight: 12 },
        },
      },
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, stacked: true },
        y: { ...defaults.scales.y, stacked: true, ticks: { ...defaults.scales.y.ticks, callback: (v) => formatTokens(v) } },
      },
    },
  });
  markCompactions(charts.tokenBreakdown, messages, c);
}

function syncSubagentShare(messages, c) {
  const chart = charts.subagentShare;
  if (!chart) return renderSubagentShareChart(messages);
  chart.data = subagentShareChartData(messages, c);
  chart.update('none');
  renderSubagentShareLegend(chart.data.slices);
}

// Grouped by agent name. A group links to its run only when it has exactly one session to open.
function subagentShareChartData(messages, c) {
  const groups = new Map();
  let main = 0;
  for (const m of messages) {
    const sa = m.subagent;
    if (!sa) {
      main += m.cost;
      continue;
    }
    const name = sa.agent || 'subagent';
    let group = groups.get(name);
    if (!group) {
      group = { name, cost: 0, sessions: new Set() };
      groups.set(name, group);
    }
    group.cost += m.cost;
    if (sa.sessionId) group.sessions.add(sa.sessionId);
  }
  const palette = chartPalette(c);
  const agents = [...groups.values()]
    .sort((a, b) => b.cost - a.cost)
    .map(({ sessions, ...g }, i) => ({
      ...g,
      sessionId: sessions.size === 1 ? [...sessions][0] : null,
      color: palette[1 + (i % (palette.length - 1))],
    }));
  // The main loop keeps the accent wherever it ranks.
  const slices = [{ name: 'main', cost: main, color: palette[0] }, ...agents].sort((a, b) => b.cost - a.cost);
  return {
    labels: slices.map((s) => s.name),
    slices,
    datasets: [
      {
        ...barDataset(
          slices.map((s) => s.cost),
          slices.map((s) => s.color),
        ),
        borderRadius: 0,
      },
    ],
  };
}

function renderSubagentShareChart(messages) {
  const canvas = document.getElementById('subagentShareChart');
  if (!canvas || !messages?.length) return;
  destroyChart('subagentShare');

  const c = getChartColors();
  const { scales: _scales, ...defaults } = chartDefaults(c);

  charts.subagentShare = new Chart(canvas, {
    type: 'doughnut',
    data: subagentShareChartData(messages, c),
    options: {
      ...defaults,
      cutout: '55%',
      onClick: (_e, els, chart) => {
        const id = chart.data.slices[els[0]?.index]?.sessionId;
        if (id) navigateToDetail(id);
      },
      onHover: (e, els, chart) => {
        e.native.target.style.cursor = chart.data.slices[els[0]?.index]?.sessionId ? 'pointer' : '';
      },
      plugins: withTooltip(defaults, {
        title: (items) => items[0]?.chart.data.slices[items[0].dataIndex]?.name || '',
        label: (ctx) => {
          const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
          return `${usd(ctx.parsed)} (${formatPct(ctx.parsed, total)}%)`;
        },
      }),
    },
  });
  renderSubagentShareLegend(charts.subagentShare.data.slices);
}

// An HTML list, not the Chart.js legend: a canvas legend that runs out of room drops entries.
function renderSubagentShareLegend(slices) {
  const el = document.getElementById('subagentShareLegend');
  if (!el) return;
  const total = slices.reduce((s, x) => s + x.cost, 0);
  el.innerHTML = slices
    .map((s) => {
      const attrs = s.sessionId ? ` class="share-agent" onclick="navigateToDetail('${escAttrJs(s.sessionId)}')"` : '';
      return `<li${attrs} title="${esc(s.name)}">
        <span class="share-swatch" style="background:${esc(withAlpha(s.color, 0.5))};border-color:${esc(s.color)}"></span>
        <span class="share-name">${esc(s.name)}</span>
        <span class="share-cost">${formatCost(s.cost)}</span>
        <span class="share-pct">${formatPct(s.cost, total)}%</span>
      </li>`;
    })
    .join('');
}

function renderTokenSplitChart(t) {
  const canvas = document.getElementById('tokenSplitChart');
  if (!canvas) return;
  destroyChart('tokenSplit');

  const c = getChartColors();
  const defaults = chartDefaults(c);
  const rows = tokenSeries(c).map(([label, key, color]) => [label, t[key], color]);
  const total = rows.reduce((s, r) => s + r[1], 0);

  charts.tokenSplit = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r[0]),
      datasets: [
        barDataset(
          rows.map((r) => r[1]),
          rows.map((r) => r[2]),
        ),
      ],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      plugins: withTooltip(defaults, {
        label: (ctx) => `${formatTokens(ctx.parsed.x)} (${formatPct(ctx.parsed.x, total)}%)`,
      }),
      // Log scale: cache reads dwarf fresh input by orders of magnitude, so a linear axis hides
      // every other bar. The tooltip carries exact values.
      scales: { ...defaults.scales, x: logAxis(defaults.scales.x, Math.max(...rows.map((r) => r[1]))) },
    },
  });
}

function renderToolsChart(tools) {
  const canvas = document.getElementById('toolsChart');
  if (!canvas || !tools?.length) return;
  destroyChart('tools');

  const c = getChartColors();
  const defaults = chartDefaults(c);
  const top = tools.slice(0, 8);
  // MCP tool names ("mcp__server__tool") are too long for axis labels, so keep the tail.
  const shortName = (n) => (n.includes('__') ? n.split('__').pop() : n);

  charts.tools = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: top.map((t) => shortName(t.name)),
      datasets: [
        barDataset(
          top.map((t) => t.count),
          c.chart2,
        ),
      ],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      interaction: { mode: 'index', axis: 'y', intersect: false },
      plugins: withTooltip(defaults, {
        title: (items) => top[items[0].dataIndex]?.name || '',
        label: (ctx) => `${ctx.parsed.x} calls`,
      }),
      scales: {
        x: { ...defaults.scales.x, ticks: { ...defaults.scales.x.ticks, precision: 0 } },
        y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, autoSkip: false } },
      },
    },
  });
}

function renderWeeklyChart(weekly) {
  const canvas = document.getElementById('weeklyChart');
  if (!canvas || !weekly?.length) return;
  destroyChart('weekly');

  const c = getChartColors();
  const defaults = chartDefaults(c);

  charts.weekly = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: weekly.map((w) => isoDayLabel(w.weekStart)),
      datasets: [
        barDataset(
          weekly.map((w) => w.cost),
          c.accent,
        ),
      ],
    },
    options: {
      ...defaults,
      plugins: withTooltip(defaults, { label: (ctx) => usd(ctx.parsed.y) }),
      scales: { ...defaults.scales, y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, callback: usdTick } } },
    },
  });
}

// #endregion

// #region RANGE_BRUSH

// Long sessions squash both per-message charts into noise, so the detail view shows a window of
// the last DETAIL_WINDOW messages and lets the user drag it across an overview of the session.
// State lives outside the DOM because renderDetail rebuilds its innerHTML on every refresh; a
// window at the tail stays there so new messages scroll into view.
const DETAIL_WINDOW_PRESETS = [25, 50, 100, 200];
const DETAIL_WINDOW = DETAIL_WINDOW_PRESETS[0];
const DETAIL_WINDOW_MIN = 10;
const detailRanges = new Map();
let detailSlice = [];

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)];
}

// A cache burst is a main-loop turn that wrote far more cache than the session normally does: the
// prompt prefix was invalidated and re-cached. Relative to the session median, with an absolute
// floor that drops noise in tiny sessions.
const CACHE_BURST_RATIO = 4;
const CACHE_BURST_MIN_TOKENS = 20000;
const SUBAGENT_COSTLY_USD = 1;
const MARKER_KINDS = {
  burst: { cls: '', label: 'cache burst' },
  compaction: { cls: 'compact', label: 'compaction' },
  agent: { cls: 'agent', label: 'subagent' },
  costlyAgent: { cls: 'agent costly', label: 'subagent', suffix: ` ≥ ${formatCost(SUBAGENT_COSTLY_USD)}` },
};

function notableEvents(messages) {
  const writes = messages
    .filter((m) => !m.subagent && m.cacheWrite > 0)
    .map((m) => m.cacheWrite)
    .sort((a, b) => a - b);
  const threshold = writes.length < 5 ? Infinity : Math.max(CACHE_BURST_MIN_TOKENS, median(writes) * CACHE_BURST_RATIO);
  return messages.flatMap((m, i) => {
    if (m.compaction) {
      const tip = `#${m.index} · compaction · replaced ${formatTokens(m.compaction.tokensBefore)} tokens · ${formatCost(m.cost)}`;
      return [{ i, kind: 'compaction', tip }];
    }
    const sa = m.subagent;
    if (sa) {
      const tip = `#${m.index} · ${sa.agent || 'subagent'}${sa.task ? ` · ${String(sa.task).slice(0, 80)}` : ''} · ${formatCost(m.cost)}`;
      return [{ i, kind: m.cost >= SUBAGENT_COSTLY_USD ? 'costlyAgent' : 'agent', tip }];
    }
    if (m.cacheWrite >= threshold) {
      return [{ i, kind: 'burst', tip: `#${m.index} · cache write ${formatTokens(m.cacheWrite)}` }];
    }
    return [];
  });
}

function clampRange(start, end, total) {
  const s = Math.max(0, Math.min(start, total - DETAIL_WINDOW_MIN));
  return { start: s, end: Math.max(s + DETAIL_WINDOW_MIN, Math.min(end, total)) };
}

function detailRangeFor(d) {
  const total = d.messages.length;
  const prev = detailRanges.get(d.id) || null;
  const size = prev ? prev.end - prev.start : DETAIL_WINDOW;
  const atTail = !prev || prev.end === prev.total;
  const start = atTail ? total - size : prev.start;
  const range = { total, ...clampRange(start, start + size, total) };
  detailRanges.set(d.id, range);
  return range;
}

function applyDetailRange(messages, range) {
  detailSlice = messages.slice(range.start, range.end);
  renderMessageRows(detailSlice, messages.length);
  const c = getChartColors();
  if (charts.cumulative && charts.tokenBreakdown) {
    charts.cumulative.data = cumulativeChartData(detailSlice, c);
    charts.tokenBreakdown.data = tokenBreakdownChartData(detailSlice, c);
    for (const chart of [charts.cumulative, charts.tokenBreakdown]) {
      markCompactions(chart, detailSlice, c);
      chart.update('none');
    }
  } else {
    renderCumulativeChart(detailSlice);
    renderTokenBreakdownChart(detailSlice);
  }
  syncSubagentShare(detailSlice, c);
}

// The overview shares the brush's percentage coordinates, so it stretches with the track.
const RANGE_OVERVIEW_SVG =
  '<svg class="rb-overview" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><polygon /><polyline /></svg>';

function rangeBrushHtml(total) {
  if (total <= DETAIL_WINDOW) return '';
  const presets = DETAIL_WINDOW_PRESETS.filter((n) => n < total)
    .map((n) => `<button type="button" class="rb-preset" data-size="${n}">${n}</button>`)
    .join('');
  return `
      <div class="range-brush" id="rangeBrush">
        <div class="rb-head">
          <span class="rb-label"><span class="rb-scope"></span><span class="rb-burst-count" hidden><i></i></span></span>
          <div class="rb-presets" role="group" aria-label="Window size">
            ${presets}
            <button type="button" class="rb-preset" data-size="all">All</button>
          </div>
        </div>
        <div class="rb-track" tabindex="0" role="slider" aria-label="Visible message range"
             aria-valuemin="1" aria-valuemax="${esc(total)}">
          ${RANGE_OVERVIEW_SVG}
          <div class="rb-bursts"></div>
          <div class="rb-window">
            <div class="rb-handle rb-handle-left" data-edge="start"></div>
            <div class="rb-handle rb-handle-right" data-edge="end"></div>
          </div>
        </div>
      </div>`;
}

function initRangeBrush(messages, range) {
  const root = document.getElementById('rangeBrush');
  if (!root) return;
  const total = messages.length;
  const q = (sel) => root.querySelector(sel);
  const track = q('.rb-track');
  const win = q('.rb-window');
  const scope = q('.rb-scope');
  const burstCount = q('.rb-burst-count');
  const presets = [...root.querySelectorAll('.rb-preset')].map((el) => ({
    el,
    size: el.dataset.size === 'all' ? total : Number(el.dataset.size),
  }));

  drawRangeOverview(q('.rb-overview'), messages);

  const markers = notableEvents(messages);
  const burstsEl = q('.rb-bursts');
  burstsEl.innerHTML = markers
    .map(
      (k) =>
        `<button type="button" class="rb-burst ${esc(MARKER_KINDS[k.kind].cls)}" data-i="${esc(String(k.i))}" style="left:${((k.i + 0.5) / total) * 100}%" title="${esc(k.tip)}" aria-label="${esc(k.tip)}"></button>`,
    )
    .join('');
  const burstEls = [...burstsEl.children].map((el, k) => ({ el, i: markers[k].i }));
  const tally = {};
  for (const k of markers) tally[k.kind] = (tally[k.kind] || 0) + 1;
  const counts = Object.entries(MARKER_KINDS)
    .filter(([kind]) => tally[kind])
    .map(([kind, { cls, label, suffix = '' }]) => {
      const n = tally[kind];
      return `<span class="${esc(cls)}"><i></i>${n} ${esc(label)}${n === 1 ? '' : 's'}${esc(suffix)}</span>`;
    });
  if (counts.length) {
    burstCount.hidden = false;
    burstCount.innerHTML = counts.join('<span class="rb-sep">·</span>');
  }

  const layout = () => {
    const size = range.end - range.start;
    win.style.left = `${(range.start / total) * 100}%`;
    win.style.width = `${(size / total) * 100}%`;
    const text =
      size === total
        ? `All ${total} messages`
        : `Messages #${messages[range.start].index} – #${messages[range.end - 1].index} · ${size} of ${total}`;
    scope.textContent = text;
    track.setAttribute('aria-valuenow', String(range.start + 1));
    track.setAttribute('aria-valuetext', text);
    for (const p of presets) p.el.classList.toggle('on', p.size === size);
    for (const b of burstEls) b.el.classList.toggle('in', b.i >= range.start && b.i < range.end);
  };

  // Pointer and wheel events outrun the frame rate, so range writes coalesce into one paint.
  let frame = 0;
  const setRange = (from, to) => {
    const next = clampRange(from, to, total);
    if (next.start === range.start && next.end === range.end) return;
    Object.assign(range, next);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
      applyDetailRange(messages, range);
    });
  };
  const size = () => range.end - range.start;
  const step = () => Math.max(1, Math.round(size() / 10));
  const pan = (delta) => setRange(range.start + delta, range.end + delta);
  const centerOn = (i) => {
    const start = Math.max(0, Math.min(i - Math.floor(size() / 2), total - size()));
    setRange(start, start + size());
  };
  const resize = (n) => {
    const end = Math.min(total, Math.max(range.end, n));
    setRange(end - n, end);
  };

  // Pointer capture keeps a fast drag alive after the cursor leaves the thin track. The rect is
  // read once per drag: reading it per move right after writing the window's style would thrash.
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    track.focus({ preventScroll: true });
    const rect = track.getBoundingClientRect();
    const perPx = total / rect.width;
    const edge = e.target.dataset?.edge;
    if (!edge && e.target !== win) centerOn(Math.round((e.clientX - rect.left) * perPx));
    const origin = { x: e.clientX, start: range.start, end: range.end };
    track.classList.add('dragging');
    track.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const delta = Math.round((ev.clientX - origin.x) * perPx);
      if (edge === 'start') setRange(origin.start + delta, origin.end);
      else if (edge === 'end') setRange(origin.start, origin.end + delta);
      else {
        const n = origin.end - origin.start;
        const start = Math.max(0, Math.min(origin.start + delta, total - n));
        setRange(start, start + n);
      }
    };
    const up = () => {
      track.classList.remove('dragging');
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });

  track.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      pan((e.deltaY || e.deltaX) > 0 ? step() : -step());
    },
    { passive: false },
  );

  track.addEventListener('keydown', (e) => {
    const n = e.shiftKey ? size() : step();
    if (e.key === 'ArrowLeft') pan(-n);
    else if (e.key === 'ArrowRight') pan(n);
    else if (e.key === 'Home') setRange(0, size());
    else if (e.key === 'End') setRange(total - size(), total);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  for (const p of presets) p.el.addEventListener('click', () => resize(p.size));

  burstsEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.rb-burst');
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    centerOn(Number(b.dataset.i));
  });

  layout();
}

function drawRangeOverview(svg, messages) {
  const n = messages.length;
  const max = messages[n - 1]?.cumulativeCost || 1;
  const pts = messages.map((m, i) => `${(i / Math.max(1, n - 1)) * 1000},${100 - (m.cumulativeCost / max) * 96 - 2}`);
  svg.querySelector('polyline').setAttribute('points', pts.join(' '));
  svg.querySelector('polygon').setAttribute('points', `0,100 ${pts.join(' ')} 1000,100`);
}

// #endregion

// #region THEME

const THEME_COLOR_TO_VAR = {
  bgDeep: '--bg-deep',
  bgSurface: '--bg-surface',
  bgElevated: '--bg-elevated',
  bgHover: '--bg-hover',
  border: '--border',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  textMuted: '--text-muted',
  accent: '--accent',
  accentText: '--accent-text',
  success: '--success',
  warning: '--warning',
  error: '--error',
};

let _themeCache = { light: null, dark: null };
let _themeDefault = { light: null, dark: null };
let _themeFamilies = [];
const COLOR_THEME_KEY = 'pi-cost:color-theme';

// Shown in a pi-kanban pane (?embed=1), pi-cost takes the board's colors over postMessage
// (pi-companion:theme), saves no theme choice, and hides its own theme controls (body.embed).
const EMBED = new URLSearchParams(location.search).get('embed') === '1' && window.parent !== window;
let _embedTheme = null;

function onEmbedMessage(e) {
  if (e.source !== window.parent || e.data?.type !== 'pi-companion:theme') return;
  const colors = {};
  for (const k of Object.keys(THEME_COLOR_TO_VAR)) {
    const v = e.data.colors?.[k];
    if (typeof v === 'string' && CSS.supports('color', v)) colors[k] = v;
  }
  const light = e.data.mode === 'light';
  _embedTheme = { mode: light ? 'light' : 'dark', colors };
  setThemeMode(light);
  repaint();
}

function startEmbed() {
  document.body.classList.add('embed');
  window.addEventListener('message', onEmbedMessage);
  window.parent.postMessage({ type: 'pi-companion:ready' }, '*');
}

function setThemeMode(light) {
  document.body.classList.toggle('light', light);
  document.body.classList.toggle('dark-forced', !light);
}

function repaint() {
  _chartColors = null;
  applyCurrentThemeColors();
  updateThemeIcon();
  renderThemeMenu();
  lastRenderHash = {};
  renderCurrentView();
}

function isLightTheme() {
  if (document.body.classList.contains('light')) return true;
  if (document.body.classList.contains('dark-forced')) return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function applyTheme(theme) {
  if (!theme || !theme.colors) return;
  const root = document.body.style;
  const c = {};
  for (const [k, cssVar] of Object.entries(THEME_COLOR_TO_VAR)) {
    const v = theme.colors[k];
    if (typeof v === 'string' && CSS.supports('color', v)) c[k] = v;
    if (c[k]) root.setProperty(cssVar, c[k]);
    else root.removeProperty(cssVar);
  }
  const isLight = theme.mode === 'light';
  const dimAlpha = isLight ? 0.15 : 0.18;
  const set = (name, color, alpha) => (color ? root.setProperty(name, withAlpha(color, alpha)) : root.removeProperty(name));
  set('--accent-dim', c.accent, isLight ? 0.18 : 0.22);
  set('--accent-glow', c.accent, isLight ? 0.5 : 0.55);
  set('--accent-faint', c.accent, isLight ? 0.06 : 0.05);
  set('--accent-soft', c.accent, 0.12);
  set('--accent-tag', c.accent, 0.15);
  set('--chart-fill', c.accent, isLight ? 0.5 : 0.6);
  set('--success-dim', c.success, dimAlpha);
  set('--warning-dim', c.warning, dimAlpha);
  set('--error-dim', c.error, dimAlpha);
}

async function loadActiveThemes() {
  try {
    const res = await fetch('/api/themes');
    if (res.ok) {
      const data = await res.json();
      _themeDefault = { light: data.light, dark: data.dark };
      _themeFamilies = data.families || [];
      const stored = EMBED ? null : storageGet('localStorage', COLOR_THEME_KEY);
      if (stored && !selectColorTheme(stored)) storageRemove('localStorage', COLOR_THEME_KEY);
      if (!stored) selectColorTheme(null);
    }
  } catch {}
}

let _colorThemeId = '';

function selectColorTheme(id) {
  const fam = id && _themeFamilies.find((f) => f.id === id);
  _themeCache = fam ? { light: fam.light, dark: fam.dark } : _themeDefault;
  _colorThemeId = fam ? fam.id : '';
  return _colorThemeId;
}

function setColorTheme(id) {
  if (EMBED) return;
  if (selectColorTheme(id)) storageSet('localStorage', COLOR_THEME_KEY, _colorThemeId);
  else storageRemove('localStorage', COLOR_THEME_KEY);
  closeThemeMenu();
  repaint();
}

function swatchStyle(t) {
  const c = t?.colors || {};
  const vars = { '--sw-bg': c.bgDeep, '--sw-accent': c.accent, '--sw-ink': c.textPrimary, '--sw-border': c.border };
  return Object.entries(vars)
    .filter(([, v]) => typeof v === 'string' && CSS.supports('color', v))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

function renderThemeMenu() {
  const menu = document.getElementById('themeMenu');
  if (!menu || EMBED) return;
  const mode = isLightTheme() ? 'light' : 'dark';
  const items = [{ id: '', displayName: 'Default', light: _themeDefault.light, dark: _themeDefault.dark }, ..._themeFamilies];
  menu.innerHTML = items
    .map((f) => {
      const on = f.id === _colorThemeId;
      return `<button class="theme-menu-item${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on ? 'true' : 'false'}" style="${esc(swatchStyle(f[mode]))}" onclick="event.stopPropagation();setColorTheme('${escAttrJs(f.id)}')" title="${esc(f[mode]?.displayName || f.displayName)}">
        <span class="theme-swatch"><i class="sw-bg"></i><i class="sw-accent"></i><i class="sw-ink"></i></span>${esc(f.displayName)}
      </button>`;
    })
    .join('');
}

function isThemeMenuOpen() {
  return !!document.getElementById('themeMenu')?.classList.contains('open');
}

function closeThemeMenu() {
  document.getElementById('themeMenu')?.classList.remove('open');
  document.removeEventListener('click', closeThemeMenu);
}

function toggleThemeMenu(e) {
  if (e?.target.closest?.('.theme-menu')) return;
  e?.stopPropagation();
  if (isThemeMenuOpen()) return closeThemeMenu();
  document.getElementById('themeMenu')?.classList.add('open');
  document.addEventListener('click', closeThemeMenu);
}

function applyCurrentThemeColors() {
  const t = _embedTheme || (isLightTheme() ? _themeCache.light : _themeCache.dark);
  if (t) applyTheme(t);
}

function updateThemeIcon() {
  const light = isLightTheme();
  const dark$ = document.getElementById('theme-icon-dark');
  const light$ = document.getElementById('theme-icon-light');
  if (dark$) dark$.style.display = light ? 'none' : 'block';
  if (light$) light$.style.display = light ? 'block' : 'none';
}

function toggleTheme() {
  if (EMBED) return;
  const nextLight = !isLightTheme();
  setThemeMode(nextLight);
  storageSet('localStorage', 'theme', nextLight ? 'light' : 'dark');
  repaint();
}

function loadTheme() {
  const saved = EMBED ? null : storageGet('localStorage', 'theme');
  if (saved === 'light' || saved === 'dark') setThemeMode(saved === 'light');
  updateThemeIcon();
  loadActiveThemes().then(repaint);
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', repaint);
}

// #endregion

// #region DATE_PICKER

// Presets are sticky: the preset is stored, and the server recomputes its window per request.
const RANGE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '24h', label: 'Last 24h' },
  { value: '3', label: '3 Days' },
  { value: '7', label: '7 Days' },
  { value: '30', label: '30 Days' },
  { value: '90', label: '90 Days' },
  { value: '365', label: '1 Year', cardLabel: '365 Days' },
];
const RANGE_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// Kept in step with the same breakpoint in style.css. One live MediaQueryList, so the listener
// added on open is the one removed on close.
const oneMonthMql = window.matchMedia('(max-width: 760px)');
const RANGE_ARROWS = {
  prev: '<path d="M6.5 1L2.5 5l4 4"/>',
  next: '<path d="M3.5 1l4 4-4 4"/>',
};

// Non-null only while the popover is open: it is both the draft and the open flag.
let rangeDraft = null;

function isRangePickerOpen() {
  return !!rangeDraft;
}

function oneMonthMode() {
  return oneMonthMql.matches;
}

// What a preset covers, for highlighting only. '24h' straddles the two calendar days it touches.
function rangePresetSpan(value) {
  const today = todayIso();
  if (value === '24h') return { from: isoShift(today, -1), to: today };
  const days = Number(value) || 1;
  return { from: days <= 1 ? today : isoShift(today, -(days - 1)), to: today };
}

function buildRangePresets() {
  const host = document.getElementById('rangePresets');
  if (!host) return;
  for (const p of RANGE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'range-preset';
    b.dataset.value = p.value;
    b.textContent = p.label;
    b.addEventListener('click', () => {
      closeRangePicker();
      applyRange(presetRange(p.value));
    });
    host.appendChild(b);
  }
}

function renderRangeTrigger() {
  const el = document.getElementById('rangeTriggerLabel');
  if (el) el.textContent = rangeTriggerLabel(dateRange);
}

function toggleRangePicker(e) {
  e?.stopPropagation();
  if (isRangePickerOpen()) closeRangePicker();
  else openRangePicker();
}

function openRangePicker() {
  const applied = normalizeRange(dateRange) || presetRange(DEFAULT_RANGE_PRESET);
  const span = applied.kind === 'custom' ? { from: applied.from, to: applied.to } : rangePresetSpan(applied.value);
  // The left pane shows the month before the window's end, so today sits in the right one.
  const [ay, am] = isoParts(span.to);
  const first = new Date(ay, am - 1 - (oneMonthMode() ? 0 : 1), 1);
  rangeDraft = {
    from: span.from,
    to: span.to,
    preset: applied.kind === 'custom' ? null : applied.value,
    picking: 'from',
    hover: null,
    month: { y: first.getFullYear(), m: first.getMonth() },
  };
  document.getElementById('rangePop').classList.add('open');
  document.getElementById('rangeTrigger').classList.add('on');
  // Capture phase: a day click re-renders the grid and detaches its own button, so by the bubble
  // phase the target is no longer inside #rangePicker and would read as an outside click.
  document.addEventListener('click', onRangePickerOutsideClick, true);
  const months = document.getElementById('rangeMonths');
  months.addEventListener('click', onRangeDayClick);
  months.addEventListener('mouseover', onRangeDayHover);
  oneMonthMql.addEventListener('change', renderRangePicker);
  renderRangePicker();
}

function closeRangePicker() {
  if (!rangeDraft) return;
  rangeDraft = null;
  document.getElementById('rangePop').classList.remove('open');
  document.getElementById('rangeTrigger').classList.remove('on');
  document.removeEventListener('click', onRangePickerOutsideClick, true);
  const months = document.getElementById('rangeMonths');
  months.removeEventListener('click', onRangeDayClick);
  months.removeEventListener('mouseover', onRangeDayHover);
  oneMonthMql.removeEventListener('change', renderRangePicker);
}

function onRangeDayClick(e) {
  const iso = e.target.dataset?.iso;
  if (iso) pickRangeDay(iso);
}

function onRangeDayHover(e) {
  const iso = e.target.dataset?.iso;
  if (iso && rangeDraft?.from && !rangeDraft.to && rangeDraft.hover !== iso) {
    rangeDraft.hover = iso;
    paintRangeSpan();
  }
}

function onRangePickerOutsideClick(e) {
  if (!document.getElementById('rangePicker').contains(e.target)) closeRangePicker();
}

function aimRangePicker(which) {
  if (!rangeDraft) return;
  rangeDraft.picking = which;
  renderRangePicker();
}

function applyRangeDraft() {
  const d = rangeDraft;
  if (!d?.from || !d.to) return;
  const next = { kind: 'custom', from: d.from, to: d.to };
  closeRangePicker();
  applyRange(next);
}

function pickRangeDay(iso) {
  const d = rangeDraft;
  d.preset = null;
  if (d.picking === 'from' || !d.from) {
    d.from = iso;
    d.to = null;
    d.picking = 'to';
  } else if (iso < d.from) {
    d.to = d.from;
    d.from = iso;
    d.picking = 'from';
  } else {
    d.to = iso;
    d.picking = 'from';
  }
  d.hover = null;
  renderRangePicker();
}

function rangeMonthStep(step) {
  const c = new Date(rangeDraft.month.y, rangeDraft.month.m + step, 1);
  rangeDraft.month = { y: c.getFullYear(), m: c.getMonth() };
  renderRangePicker();
}

// There is no cost data ahead of today, so the calendar stops at the current month.
function rangeNextDisabled() {
  const last = new Date(rangeDraft.month.y, rangeDraft.month.m + (oneMonthMode() ? 0 : 1), 1);
  const now = new Date();
  return last >= new Date(now.getFullYear(), now.getMonth(), 1);
}

function rangeDraftSpan() {
  const d = rangeDraft;
  if (!d?.from) return [null, null];
  if (d.to) return [d.from, d.to];
  if (!d.hover) return [d.from, d.from];
  return d.hover < d.from ? [d.hover, d.from] : [d.from, d.hover];
}

// Sole owner of the four span classes, so a hover repaint toggles them in place instead of
// rebuilding both grids.
function paintRangeSpan() {
  const [a, b] = rangeDraftSpan();
  for (const btn of document.querySelectorAll('#rangeMonths .range-day[data-iso]')) {
    const iso = btn.dataset.iso;
    const inSpan = !!(a && b && iso >= a && iso <= b);
    const edge = inSpan && (iso === a || iso === b);
    btn.classList.toggle('edge', edge);
    btn.classList.toggle('in', inSpan && !edge);
    btn.classList.toggle('start', inSpan && !edge && isoShift(iso, -1) === a);
    btn.classList.toggle('end', inSpan && !edge && isoShift(iso, 1) === b);
  }
}

function renderRangePicker() {
  const d = rangeDraft;
  if (!d) return;

  for (const b of document.querySelectorAll('#rangePresets .range-preset')) {
    b.classList.toggle('on', b.dataset.value === d.preset);
  }

  const fromBox = document.getElementById('rangeFromBox');
  const toBox = document.getElementById('rangeToBox');
  fromBox.textContent = d.from ? isoDayLabel(d.from) : '—';
  toBox.textContent = d.to ? isoDayLabel(d.to) : '—';
  fromBox.classList.toggle('empty', !d.from);
  toBox.classList.toggle('empty', !d.to);
  fromBox.classList.toggle('active', d.picking === 'from');
  toBox.classList.toggle('active', d.picking === 'to');

  const [a, b] = rangeDraftSpan();
  const days = d.from && d.to ? isoDayCount(a, b) : 0;
  document.getElementById('rangeSummary').textContent = days ? `${days} ${days === 1 ? 'day' : 'days'}` : 'pick an end date';
  document.getElementById('rangeApply').disabled = !(d.from && d.to);

  const host = document.getElementById('rangeMonths');
  host.innerHTML = '';
  const single = oneMonthMode();
  const first = new Date(d.month.y, d.month.m, 1);
  host.appendChild(buildRangeMonth(first.getFullYear(), first.getMonth(), { prev: true, next: single }));
  if (!single) {
    const second = new Date(d.month.y, d.month.m + 1, 1);
    host.appendChild(buildRangeMonth(second.getFullYear(), second.getMonth(), { prev: false, next: true }));
  }
  paintRangeSpan();
}

function rangeNavButton(dir) {
  const step = dir === 'next' ? 1 : -1;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'range-nav';
  btn.innerHTML = `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${RANGE_ARROWS[dir]}</svg>`;
  if (step > 0) btn.disabled = rangeNextDisabled();
  btn.addEventListener('click', () => rangeMonthStep(step));
  return btn;
}

function rangeNavGap() {
  const gap = document.createElement('span');
  gap.className = 'range-nav-gap';
  return gap;
}

function buildRangeMonth(y, m, nav) {
  const wrap = document.createElement('div');
  wrap.className = 'range-cal';

  const head = document.createElement('div');
  head.className = 'range-cal-head';
  head.appendChild(nav.prev ? rangeNavButton('prev') : rangeNavGap());
  const titleEl = document.createElement('span');
  titleEl.className = 'range-cal-title';
  titleEl.textContent = `${new Date(y, m, 1).toLocaleDateString(undefined, { month: 'short' }).toUpperCase()} ${y}`;
  head.appendChild(titleEl);
  head.appendChild(nav.next ? rangeNavButton('next') : rangeNavGap());
  wrap.appendChild(head);

  const dow = document.createElement('div');
  dow.className = 'range-dow';
  dow.innerHTML = RANGE_DOW.map((d) => `<span>${d}</span>`).join('');
  wrap.appendChild(dow);

  const grid = document.createElement('div');
  grid.className = 'range-grid';
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const dayCount = new Date(y, m + 1, 0).getDate();
  const today = todayIso();

  for (let i = 0; i < lead; i++) {
    const pad = document.createElement('span');
    pad.className = 'range-day pad';
    grid.appendChild(pad);
  }
  for (let day = 1; day <= dayCount; day++) {
    const iso = isoDate(new Date(y, m, day));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'range-day';
    btn.textContent = day;
    if (iso === today) btn.classList.add('today');
    if (iso > today) {
      btn.classList.add('off');
      btn.disabled = true;
    } else {
      btn.dataset.iso = iso;
    }
    grid.appendChild(btn);
  }
  wrap.appendChild(grid);
  return wrap;
}

// #endregion

// #region ROUTER

function setActiveNav(view) {
  document.querySelectorAll('.topbar-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(viewId);
  if (el) el.classList.add('active');
}

async function navigate(view, params, urlMode = 'push') {
  currentView = view;
  if (params?.project) currentProjectDir = params.project;
  if (params?.projectName) currentProjectName = params.projectName;
  if (params?.session) currentSessionId = params.session;

  if (TOP_VIEWS.includes(view)) {
    currentProjectDir = null;
    currentProjectName = null;
    currentSessionId = null;
  }
  if (view === 'sessions') currentSessionId = null;

  setActiveNav(view === 'sessions' || view === 'detail' ? parentView : view);
  updateUrl(urlMode);
  await loadAndRender(view);
  if (view !== 'detail') selectRow(0);
}

async function navigateToSessions(projectDir, name) {
  if (currentView === 'overview' || currentView === 'projects') parentView = currentView;
  lastSelectedProject = projectDir;
  currentProjectDir = projectDir;
  currentProjectName = name;
  sessionsData = null;
  await navigate('sessions', { project: projectDir, projectName: name });
}

async function navigateToDetail(sessionId) {
  lastSelectedSession = sessionId;
  currentSessionId = sessionId;
  sessionDetailData = null;
  await navigate('detail', { session: sessionId });
}

function sortBy(field) {
  const s = currentSort();
  if (!s) return;
  if (s.field === field) s.order = s.order === 'desc' ? 'asc' : 'desc';
  else {
    s.field = field;
    s.order = 'desc';
  }
  lastRenderHash[currentView] = null;
  saveSort();
  updateUrl('replace');
  if (currentView === 'overview') renderOverview();
  else if (currentView === 'sessions') renderSessions();
  else if (currentView === 'projects') renderProjects();
}

// The one entry point for a range change. The renderers are hash-gated, so the hash reset is what
// makes them repaint the new window.
async function applyRange(next) {
  dateRange = next;
  saveDateRange(dateRange);
  lastRenderHash = {};
  renderRangeTrigger();
  updateUrl('replace');
  const t = showToast(`Recalculating for ${rangeLabel(dateRange)}...`, true);
  await loadAndRender(currentView);
  dismissToast(t);
}

async function refreshData() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  const t = showToast(`Recalculating for ${rangeLabel(dateRange)}...`, true);
  const minWait = new Promise((r) => setTimeout(r, 250));
  try {
    await fetch('/api/refresh', { method: 'POST' });
    dataCache.clear();
    forceRefresh = true;
    lastRenderHash = {};
    await loadAndRender(currentView);
    await minWait;
    showToast('Data refreshed', false, 'success');
  } finally {
    forceRefresh = false;
    dismissToast(t);
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function loadAndRender(view) {
  const myNav = ++navCounter;
  const prevSelectedIdx = selectedRowIdx;
  ensureViewElements();
  showView(`${view}-view`);

  const viewEl = document.getElementById(`${view}-view`);
  if (viewEl && !viewEl.querySelector('.dashboard-content')) viewEl.innerHTML = skeletonHtml(view);

  try {
    switch (view) {
      case 'overview':
        await fetchOverview();
        if (myNav !== navCounter) return;
        renderOverview();
        break;
      case 'insights':
        await fetchInsights();
        if (myNav !== navCounter) return;
        renderInsights();
        break;
      case 'projects':
        await fetchProjects();
        if (myNav !== navCounter) return;
        renderProjects();
        break;
      case 'sessions':
        if (currentProjectDir) {
          if (!sessionsData) {
            lastRenderHash.sessions = null;
            renderSessions();
          }
          await fetchSessions(currentProjectDir);
          if (myNav !== navCounter) return;
          renderSessions();
        }
        break;
      case 'detail':
        if (currentSessionId) {
          if (!sessionDetailData) {
            lastRenderHash.detail = null;
            renderDetail();
          }
          await fetchSessionDetail(currentSessionId);
          if (myNav !== navCounter) return;
          renderDetail();
        }
        break;
    }
    if (prevSelectedIdx >= 0) selectRow(prevSelectedIdx);
  } catch (err) {
    if (myNav !== navCounter) return;
    console.error(`Failed to load ${view}:`, err);
    // The cursor comes back from sessionStorage, so it can point at a session another agent dir
    // never had. A 404 there is a stale cursor: drop it and land on the overview.
    if (err.status === 404 && view === 'detail') {
      sessionDetailData = null;
      showToast('Session not found — showing overview');
      await navigate('overview', undefined, 'replace');
      return;
    }
    showToast(`Error: ${err.message}`);
    if (viewEl) viewEl.innerHTML = `<div class="loading-state"><span>Failed to load: ${esc(err.message)}</span></div>`;
  } finally {
    if (myNav === navCounter) booted = true;
  }
}

function renderCurrentView() {
  loadAndRender(currentView);
}

function ensureViewElements() {
  const app = document.getElementById('app');
  if (!app) return;
  for (const v of ['overview', 'insights', 'projects', 'sessions', 'detail']) {
    if (!document.getElementById(`${v}-view`)) {
      const div = document.createElement('div');
      div.id = `${v}-view`;
      div.className = 'view';
      app.appendChild(div);
    }
  }
  const ls = document.getElementById('loadingState');
  if (ls) ls.remove();
}

// #endregion

// #region MODAL

const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['1'], label: 'Overview' },
      { keys: ['2'], label: 'Insights' },
      { keys: ['3'], label: 'Projects' },
      { keys: ['Backspace'], label: 'Go back' },
      { keys: ['Esc'], label: 'Close / back' },
    ],
  },
  {
    title: 'Table',
    rows: [
      { keys: ['J', '↓'], label: 'Next row' },
      { keys: ['K', '↑'], label: 'Previous row' },
      { keys: ['Enter', 'Space'], label: 'Open' },
    ],
  },
  {
    title: 'Timeline range',
    rows: [
      { keys: ['←', '→'], label: 'Pan one step' },
      { keys: ['Shift', '←/→'], combo: true, label: 'Pan a full window' },
      { keys: ['Home', 'End'], label: 'Jump to start / end' },
    ],
  },
  {
    title: 'Actions',
    rows: [
      { keys: ['R'], label: 'Refresh' },
      { keys: ['T'], label: 'Toggle theme' },
      { keys: ['?'], label: 'This help' },
    ],
  },
];

function buildHelpShortcuts() {
  return SHORTCUT_GROUPS.map((g) => {
    const rows = g.rows
      .map((r) => {
        const sep = r.combo ? ' + ' : ' / ';
        return `<tr><td>${r.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(sep)}</td><td>${esc(r.label)}</td></tr>`;
      })
      .join('');
    return `<div><h4 class="shortcut-section">${esc(g.title)}</h4><table class="shortcut-table">${rows}</table></div>`;
  }).join('');
}

function toggleHelpModal() {
  const list = document.getElementById('helpShortcuts');
  if (list && !list.childElementCount) list.innerHTML = buildHelpShortcuts();
  document.getElementById('helpModal').classList.toggle('visible');
}

// #endregion

// #region KEYBOARD

function getVisibleRows() {
  const viewEl = document.getElementById(`${currentView}-view`);
  if (!viewEl) return [];
  return Array.from(viewEl.querySelectorAll('tbody tr[data-clickable]'));
}

function selectRow(idx) {
  const rows = getVisibleRows();
  rows.forEach((r) => r.classList.remove('kb-selected'));
  if (idx >= 0 && idx < rows.length) {
    selectedRowIdx = idx;
    rows[idx].classList.add('kb-selected');
    rows[idx].scrollIntoView({ block: 'nearest' });
  } else {
    selectedRowIdx = -1;
  }
}

function activateSelectedRow() {
  const rows = getVisibleRows();
  if (selectedRowIdx >= 0 && selectedRowIdx < rows.length) rows[selectedRowIdx].click();
}

async function goBack() {
  let target;
  if (currentView === 'detail') {
    if (currentProjectDir) {
      target = 'sessions';
      await navigate('sessions', { project: currentProjectDir, projectName: currentProjectName });
    } else {
      target = parentView;
      await navigate(parentView);
    }
  } else if (currentView === 'sessions') {
    target = parentView;
    await navigate(parentView);
  } else if (currentView === 'projects' || currentView === 'insights') {
    target = 'overview';
    await navigate('overview');
  }
  if (target) focusPreviousRow(target);
}

const KEY_VIEWS = { 1: 'overview', 2: 'insights', 3: 'projects' };

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  const anyModal = document.querySelector('.modal-overlay.visible');
  if (anyModal) {
    if (e.key === 'Escape' || (e.key === '?' && anyModal.id === 'helpModal')) {
      anyModal.classList.remove('visible');
      e.preventDefault();
    }
    return;
  }

  // The popover is a div, so the INPUT guard does not cover it, and r/t/j/k would fire through it.
  if (isRangePickerOpen()) {
    if (e.key === 'Escape') {
      closeRangePicker();
      e.preventDefault();
    }
    return;
  }

  if (isThemeMenuOpen()) {
    if (e.key === 'Escape') {
      closeThemeMenu();
      document.getElementById('themePickerBtn')?.focus();
      e.preventDefault();
    }
    return;
  }

  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    toggleHelpModal();
    return;
  }
  if (KEY_VIEWS[e.key]) {
    e.preventDefault();
    navigate(KEY_VIEWS[e.key]);
    return;
  }
  if (e.key === 'r') {
    e.preventDefault();
    refreshData();
    return;
  }
  if (e.key === 't') {
    e.preventDefault();
    toggleTheme();
    return;
  }
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault();
    goBack();
    return;
  }
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    const rows = getVisibleRows();
    if (rows.length) selectRow(Math.min(selectedRowIdx + 1, rows.length - 1));
    return;
  }
  if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = getVisibleRows();
    if (rows.length) selectRow(Math.max(selectedRowIdx - 1, 0));
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activateSelectedRow();
  }
});

// #endregion

// #region TOAST

function showToast(msg, persistent, type) {
  const container = document.getElementById('toast');
  if (!container) return;
  const el = document.createElement('div');
  el.className = type ? `toast toast-${type}` : 'toast';
  el.textContent = msg;
  container.appendChild(el);
  if (!persistent) setTimeout(() => el.remove(), 3000);
  return el;
}

function dismissToast(el) {
  if (el) el.remove();
}

// #endregion

// #region AUTO_REFRESH

const STALE_CHECK_MS = 30_000;
// The interval and visibilitychange share refreshIfStale, so a second trigger must not clear
// forceRefresh under the first.
let refreshing = false;

async function refreshIfStale() {
  if (refreshing || document.hidden) return;
  if (Date.now() - dataFetchedAt < BROWSER_CACHE_TTL) return;
  refreshing = true;
  forceRefresh = true;
  try {
    await loadAndRender(currentView);
  } catch {
  } finally {
    forceRefresh = false;
    refreshing = false;
  }
}

setInterval(refreshIfStale, STALE_CHECK_MS);
document.addEventListener('visibilitychange', refreshIfStale);

// #endregion

// #region PI_INTEGRATION

(async function initPi() {
  try {
    window.__PI__ = await fetch('/pi-config').then((r) => r.json());
  } catch {}
})();

// #endregion

// #region PWA

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let deferredInstallPrompt = null;

function setInstallPrompt(e) {
  deferredInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.hidden = !e;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  setInstallPrompt(e);
});

window.addEventListener('appinstalled', () => setInstallPrompt(null));

async function promptInstall() {
  const e = deferredInstallPrompt;
  if (!e) return;
  setInstallPrompt(null);
  await e.prompt();
}

// #endregion

// #region INIT

loadTheme();
if (EMBED) startEmbed();
loadSort();

document.addEventListener('click', async (e) => {
  if (e.target.matches('.parent-breadcrumb')) {
    const target = parentView;
    await navigate(target);
    focusPreviousRow(target);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const state = getUrlState();
  dateRange = loadDateRange();
  buildRangePresets();
  renderRangeTrigger();

  if (state.session) {
    currentSessionId = state.session;
    parentView = state.parentView;
    currentProjectDir = state.project;
    currentProjectName = state.projectName;
    await navigate('detail', { session: state.session }, 'replace');
  } else if (state.project) {
    parentView = state.parentView;
    currentProjectDir = state.project;
    currentProjectName = state.projectName;
    await navigate('sessions', { project: state.project, projectName: state.projectName }, 'replace');
  } else {
    await navigate(TOP_VIEWS.includes(state.view) ? state.view : 'overview', undefined, 'replace');
  }
});

window.addEventListener('popstate', () => {
  const p = new URLSearchParams(window.location.search);
  currentView = p.get('view') || 'overview';
  parentView = p.get('parentView') || 'projects';
  currentProjectDir = p.get('project');
  currentProjectName = p.get('projectName');
  currentSessionId = p.get('session');
  if (p.has('session') && currentView === 'overview') currentView = 'detail';
  lastRenderHash = {};
  storageSet('sessionStorage', 'pi-cost:nav', p.toString());
  setActiveNav(currentView === 'sessions' || currentView === 'detail' ? parentView : currentView);
  loadAndRender(currentView);
});

// Exposed for the inline handlers in markup.
Object.assign(window, {
  navigate,
  navigateToSessions,
  navigateToDetail,
  sortBy,
  refreshData,
  toggleTheme,
  toggleThemeMenu,
  setColorTheme,
  toggleHelpModal,
  toggleRangePicker,
  closeRangePicker,
  aimRangePicker,
  applyRangeDraft,
  promptInstall,
});

// #endregion
