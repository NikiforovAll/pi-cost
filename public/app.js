// #region STATE

let currentView = 'overview';
let overviewData = null;
let projectsData = null;
let sessionsData = null;
let sessionsDaily = null;
let sessionsModelDistribution = null;
let currentProjectInfo = null;
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
let dateRange = 3;
const charts = {};
let lastRenderHash = {};
let navCounter = 0;
let selectedRowIdx = -1;

// #endregion

// #region UTILS

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function basename(p) {
  const s = String(p ?? '');
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

// Escape for use inside a single-quoted JS string embedded in an HTML attribute.
// Without this, Windows paths like C:\Users\nikiforovall lose \U \n \d as JS escapes.
function jsStr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function shortDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  let va = a[field], vb = b[field];
  if (va == null) va = '';
  if (vb == null) vb = '';
  if (typeof va === 'string') va = va.toLowerCase();
  if (typeof vb === 'string') vb = vb.toLowerCase();
  if (va < vb) return order === 'asc' ? -1 : 1;
  if (va > vb) return order === 'asc' ? 1 : -1;
  return 0;
}

function currentSort() { return viewSort[currentView]; }

function sortArrow(field) {
  const s = currentSort();
  if (!s || s.field !== field) return '';
  return `<span class="sort-arrow">${s.order === 'asc' ? '▲' : '▼'}</span>`;
}

function thClass(field) {
  const s = currentSort();
  return s && s.field === field ? 'sorted' : '';
}

function parentBreadcrumb() {
  const label = parentView === 'overview' ? 'Overview' : 'Projects';
  return `<a class="parent-breadcrumb">${label}</a>`;
}

function focusPreviousRow(view) {
  let selector;
  if (view === 'overview' || view === 'projects') {
    if (!lastSelectedProject) return;
    selector = `tr[data-key="${cssAttrEscape(lastSelectedProject)}"]`;
  } else if (view === 'sessions') {
    if (!lastSelectedSession) return;
    selector = `tr[data-key="${cssAttrEscape(lastSelectedSession)}"]`;
  }
  if (!selector) return;
  requestAnimationFrame(() => {
    const rows = getVisibleRows();
    const idx = rows.findIndex((r) => r.matches(selector));
    selectRow(idx >= 0 ? idx : 0);
  });
}

function cssAttrEscape(s) {
  return String(s).replace(/"/g, '\\"');
}

// #endregion

// #region URL_STATE

function getUrlState() {
  let p = new URLSearchParams(window.location.search);
  if (!p.has('view') && !p.has('session') && !p.has('project')) {
    const saved = sessionStorage.getItem('pi-cost:nav');
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

function loadDateRange() {
  const v = localStorage.getItem('pi-cost:range');
  if (!v) return 3;
  if (v === 'today') return 'today';
  return parseInt(v, 10) || 3;
}

function saveDateRange(val) { localStorage.setItem('pi-cost:range', String(val)); }

function rangeLabel(r) { return r === 'today' ? 'today' : `${r} days`; }

function loadSort() {
  for (const view of Object.keys(DEFAULT_SORT)) {
    const raw = localStorage.getItem(`pi-cost:sort:${view}`);
    if (raw) {
      try {
        const { field, order } = JSON.parse(raw);
        if (field) viewSort[view].field = field;
        if (order) viewSort[view].order = order;
      } catch {}
    }
  }
}

function saveSort() {
  localStorage.setItem(`pi-cost:sort:${currentView}`, JSON.stringify(currentSort()));
}

function updateUrl(mode = 'push') {
  const p = new URLSearchParams();
  if (currentView !== 'overview') p.set('view', currentView);
  if (currentProjectDir) p.set('project', currentProjectDir);
  if (currentProjectName) p.set('projectName', currentProjectName);
  if (currentSessionId) p.set('session', currentSessionId);
  if (parentView !== 'projects') p.set('parentView', parentView);
  const qs = p.toString();
  const url = qs ? `?${qs}` : '/';
  const sameAsCurrent = (location.search || '') === (qs ? `?${qs}` : '');
  const method = mode === 'push' && !sameAsCurrent ? 'pushState' : 'replaceState';
  history[method](null, '', url);
  sessionStorage.setItem('pi-cost:nav', qs);
}

// #endregion

// #region FETCH

let forceRefresh = false;

async function fetchJSON(url) {
  const res = await fetch(url, forceRefresh ? { cache: 'reload' } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchOverview() {
  overviewData = await fetchJSON(`/api/overview?range=${dateRange}`);
}

async function fetchProjects() {
  const data = await fetchJSON(`/api/projects?range=${dateRange}`);
  projectsData = data.projects;
}

async function fetchSessions(projectDir) {
  const data = await fetchJSON(`/api/projects/${encodeURIComponent(projectDir)}/sessions?range=${dateRange}`);
  sessionsData = data.sessions || [];
  sessionsDaily = data.daily || [];
  sessionsModelDistribution = data.modelDistribution || [];
  currentProjectInfo = data.project || null;
}

async function fetchSessionDetail(sessionId) {
  sessionDetailData = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (sessionDetailData && !currentProjectDir) {
    currentProjectDir = sessionDetailData.projectDir;
    currentProjectName = sessionDetailData.cwd;
  }
}

// #endregion

// #region RENDER_OVERVIEW

function renderOverview() {
  const el = document.getElementById('overview-view');
  if (!el) return;
  if (!overviewData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const s = overviewData.summary;
  const h = JSON.stringify({ overviewData, sort: viewSort.overview });
  if (lastRenderHash.overview === h) return;
  lastRenderHash.overview = h;

  const daily = overviewData.daily || [];
  const models = overviewData.modelDistribution || [];
  const projects = overviewData.projects || [];
  const meta = overviewData.pricingMeta || {};
  const sc = s.sourceCounts || {};
  const totalRows = (sc.jsonl || 0) + (sc.pricing || 0) + (sc.none || 0);
  const pctEst = totalRows ? Math.round(((sc.pricing || 0) / totalRows) * 100) : 0;

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="cards-row">
        <div class="stat-card">
          <div class="card-label">Today</div>
          <div class="card-value cost">${formatCost(s.todayCost)}</div>
        </div>
        ${dateRange === 'today' ? '' : `
        <div class="stat-card">
          <div class="card-label">${dateRange} Days</div>
          <div class="card-value cost">${formatCost(s.totalCost)}</div>
        </div>`}
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
          <div class="card-value">${(s.cacheEfficiency * 100).toFixed(1)}%</div>
          <div class="card-sub">Read: ${formatTokens(s.totalCacheRead)} / Write: ${formatTokens(s.totalCacheWrite)}</div>
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
          <div class="chart-title">Daily Cost</div>
          <canvas id="dailyChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Cost by Model</div>
          <canvas id="modelChart"></canvas>
        </div>
      </div>

      ${projects.length ? `
      <div class="section-title">Projects</div>
      <table class="data-table">
        <thead><tr>
          <th class="${thClass('name')}" onclick="sortBy('name')">Project ${sortArrow('name')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('sessions')}" onclick="sortBy('sessions')">Sessions ${sortArrow('sessions')}</th>
          <th class="${thClass('lastActive')}" onclick="sortBy('lastActive')">Last Active ${sortArrow('lastActive')}</th>
          <th>Model</th>
        </tr></thead>
        <tbody>
          ${[...projects]
            .sort((a, b) => sortCompare(a, b, viewSort.overview.field, viewSort.overview.order))
            .map((p) => `
            <tr data-clickable data-key="${esc(p.projectDir)}" onclick="navigateToSessions('${jsStr(p.projectDir)}','${jsStr(p.name)}')">
              <td title="${esc(p.cwd)}">${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessions}</td>
              <td class="muted">${timeAgo(p.lastActive)}</td>
              <td><span class="model-badge">${esc(shortModel(p.primaryModel))}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}
    </div>`;

  requestAnimationFrame(() => {
    renderDailyChart(daily);
    renderModelChart(models);
  });
}

// #endregion

// #region RENDER_PROJECTS

function renderProjects() {
  const el = document.getElementById('projects-view');
  if (!el) return;
  if (!projectsData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const h = JSON.stringify({ projectsData, sort: viewSort.projects });
  if (lastRenderHash.projects === h) return;
  lastRenderHash.projects = h;

  const sorted = [...projectsData].sort((a, b) => sortCompare(a, b, viewSort.projects.field, viewSort.projects.order));

  if (sorted.length === 0) {
    el.innerHTML = `<div class="dashboard-content"><div class="empty-state">
      <div class="empty-icon">$</div>
      <div>No project data found</div>
      <div>Make sure pi session files exist in ~/.pi/agent/sessions/</div>
    </div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="section-title">All Projects</div>
      <table class="data-table">
        <thead><tr>
          <th class="${thClass('name')}" onclick="sortBy('name')">Project ${sortArrow('name')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('sessions')}" onclick="sortBy('sessions')">Sessions ${sortArrow('sessions')}</th>
          <th class="${thClass('totalTokens')}" onclick="sortBy('totalTokens')">Tokens ${sortArrow('totalTokens')}</th>
          <th class="${thClass('lastActive')}" onclick="sortBy('lastActive')">Last Active ${sortArrow('lastActive')}</th>
          <th>Model</th>
        </tr></thead>
        <tbody>
          ${sorted.map((p) => `
            <tr data-clickable data-key="${esc(p.projectDir)}" onclick="navigateToSessions('${jsStr(p.projectDir)}','${jsStr(p.name)}')">
              <td title="${esc(p.cwd)}">${esc(p.name)}</td>
              <td class="cost-cell">${formatCost(p.totalCost)}</td>
              <td>${p.sessions}</td>
              <td>${formatTokens(p.totalTokens)}</td>
              <td class="muted">${timeAgo(p.lastActive)}</td>
              <td><span class="model-badge">${esc(shortModel(p.primaryModel))}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// #endregion

// #region RENDER_SESSIONS

function renderSessions() {
  const el = document.getElementById('sessions-view');
  if (!el) return;
  if (!sessionsData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
    return;
  }

  const h = JSON.stringify({ sessionsData, sessionsDaily, sessionsModelDistribution, sort: viewSort.sessions });
  if (lastRenderHash.sessions === h) return;
  lastRenderHash.sessions = h;

  const total = sessionsData.reduce((s, x) => s + (x.totalCost || 0), 0);

  if (sessionsData.length === 0) {
    el.innerHTML = `<div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <span class="current" title="${esc(currentProjectName || '')}">${esc(basename(currentProjectName) || 'Project')}</span>
      </div>
      <div class="empty-state"><div>No sessions found for this project</div></div>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <span class="current" title="${esc(currentProjectName || '')}">${esc(basename(currentProjectName) || 'Project')}</span>
      </div>
      <div class="charts-row" style="grid-template-columns:3fr 2fr auto">
        <div class="chart-box">
          <div class="chart-title">Daily Cost</div>
          <canvas id="sessionsDailyChart"></canvas>
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
          <th class="${thClass('customTitle')}" onclick="sortBy('customTitle')">Session ${sortArrow('customTitle')}</th>
          <th class="${thClass('totalCost')}" onclick="sortBy('totalCost')">Cost ${sortArrow('totalCost')}</th>
          <th class="${thClass('totalTokens')}" onclick="sortBy('totalTokens')">Tokens ${sortArrow('totalTokens')}</th>
          <th class="${thClass('messageCount')}" onclick="sortBy('messageCount')">Msgs ${sortArrow('messageCount')}</th>
          <th>Provider</th>
          <th>Model</th>
          <th class="${thClass('lastTimestamp')}" onclick="sortBy('lastTimestamp')">Last Active ${sortArrow('lastTimestamp')}</th>
        </tr></thead>
        <tbody>
          ${[...sessionsData]
            .sort((a, b) => sortCompare(a, b, viewSort.sessions.field, viewSort.sessions.order))
            .map((s) => {
              const label = s.customTitle || shortId(s.id);
              const preview = s.firstUserText ? s.firstUserText.slice(0, 60) : '';
              return `
            <tr data-clickable data-key="${esc(s.id)}" onclick="navigateToDetail('${esc(s.id)}')">
              <td class="truncate" title="${esc(s.id)}${preview ? ` — ${esc(s.firstUserText || '')}` : ''}"><code class="session-id">${esc(label)}</code>${preview ? ` <span class="muted">${esc(preview)}${s.firstUserText && s.firstUserText.length > 60 ? '…' : ''}</span>` : ''}${s.parentSession ? ' <span class="subagent-tag">subagent</span>' : ''}${s.subagentCount ? ` <span class="subagent-tag" title="${s.subagentCount} spawned subagent(s) totaling ${formatCost(s.subagentCost)}">+${s.subagentCount}</span>` : ''}</td>
              <td class="cost-cell">${formatCost(s.totalCost)}</td>
              <td>${formatTokens(s.totalTokens)}</td>
              <td>${s.messageCount}</td>
              <td class="muted">${esc(s.provider || '')}</td>
              <td><span class="model-badge">${esc(shortModel(s.model))}</span></td>
              <td class="muted">${timeAgo(s.lastTimestamp)}</td>
            </tr>`;
            }).join('')}
        </tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    renderDailyChart(sessionsDaily || [], 'sessionsDailyChart', 'sessionsDaily');
    renderModelChart(sessionsModelDistribution || [], 'sessionsModelChart', 'sessionsModel');
  });
}

// #endregion

// #region RENDER_DETAIL

function renderDetail() {
  const el = document.getElementById('detail-view');
  if (!el) return;
  if (!sessionDetailData) {
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
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

  el.innerHTML = `
    <div class="dashboard-content">
      <div class="breadcrumb">
        ${parentBreadcrumb()}
        <span class="sep">/</span>
        <a onclick="navigateToSessions('${jsStr(projectDir)}','${jsStr(projectName)}')" title="${esc(projectCwd)}">${esc(projectName)}</a>
        <span class="sep">/</span>
        <span class="current" title="${esc(d.id || '')}"><code class="session-id">${esc(d.customTitle || shortId(d.id))}</code></span>
      </div>

      ${d.firstUserText ? `<div style="color:var(--text-tertiary);font-size:12px;margin-bottom:16px;font-style:italic">"${esc(d.firstUserText.slice(0, 240))}${d.firstUserText.length > 240 ? '...' : ''}"</div>` : ''}

      <div class="detail-header">
        <div class="detail-stat">
          <div class="detail-label">Total Cost</div>
          <div class="detail-value cost">${formatCost(d.totalCost)}</div>
          ${d.subagentCount ? `<div class="detail-sub">+ ${formatCost(d.subagentCost)} subagents (${d.subagentCount}) = <strong>${formatCost(d.totalCost + d.subagentCost)}</strong></div>` : ''}
        </div>
        <div class="detail-stat">
          <div class="detail-label">Input</div>
          <div class="detail-value">${formatTokens(d.totalInput)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Output</div>
          <div class="detail-value">${formatTokens(d.totalOutput)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Cache Write</div>
          <div class="detail-value">${formatTokens(d.totalCacheWrite)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Cache Read</div>
          <div class="detail-value">${formatTokens(d.totalCacheRead)}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Messages</div>
          <div class="detail-value">${d.messages.length}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Models</div>
          <div class="detail-value">${(d.models || []).map(shortModel).filter(Boolean).join(', ') || '—'}</div>
        </div>
        <div class="detail-stat">
          <div class="detail-label">Source</div>
          <div class="detail-value" style="font-size:12px">
            ${srcBadge('jsonl')} ${sc.jsonl || 0}
            &nbsp;${srcBadge('pricing')} ${sc.pricing || 0}
          </div>
        </div>
      </div>

      <div class="charts-row" style="margin-bottom:20px">
        <div class="chart-box">
          <div class="chart-title">Cumulative Cost</div>
          <canvas id="cumulativeChart"></canvas>
        </div>
        <div class="chart-box">
          <div class="chart-title">Token Breakdown per Message</div>
          <canvas id="tokenBreakdownChart"></canvas>
        </div>
      </div>

      ${d.childSessions && d.childSessions.length ? `
      <div class="section-title">Spawned sessions (${d.childSessions.length})</div>
      <table class="data-table" style="margin-bottom:20px">
        <thead><tr><th>Session</th><th>Cost</th><th>Tokens</th><th>Msgs</th><th>Model</th><th>When</th></tr></thead>
        <tbody>
          ${d.childSessions.map((sa) => {
            const label = sa.customTitle || shortId(sa.id);
            const preview = sa.firstUserText ? sa.firstUserText.slice(0, 120) : '';
            return `<tr data-clickable onclick="navigateToDetail('${esc(sa.id)}')">
              <td class="truncate" title="${esc(sa.id)}${preview ? ` — ${esc(preview)}` : ''}"><code class="session-id">${esc(label)}</code>${preview ? ` <span class="muted">${esc(preview)}</span>` : ''}</td>
              <td class="cost-cell">${formatCost(sa.totalCost)}</td>
              <td>${formatTokens(sa.totalTokens)}</td>
              <td>${sa.messageCount}</td>
              <td><span class="model-badge">${esc(shortModel(sa.model))}</span></td>
              <td class="muted">${timeAgo(sa.lastTimestamp)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : ''}

      <div class="section-title">Messages (${d.messages.length})</div>
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
        <tbody>
          ${[...d.messages].reverse().map((m, idxRev) => {
            const idx = d.messages.length - idxRev;
            const isSub = !!m.agent;
            const sid = m.subagentSessionId;
            const clickable = isSub && sid;
            const rowAttrs = isSub
              ? ` class="subagent-row${clickable ? ' clickable' : ''}" title="${esc(m.task || '')}${clickable ? ' — click to open subagent session' : ''}"${clickable ? ` onclick="navigateToDetail('${esc(sid)}')"` : ''}`
              : '';
            return `<tr${rowAttrs}>
              <td class="muted">${idx}</td>
              <td class="muted">${m.ts ? new Date(m.ts).toLocaleTimeString() : ''}</td>
              <td>${isSub ? `<span class="subagent-tag">${esc(m.agent)}</span> ` : ''}<span class="model-badge">${esc(shortModel(m.model))}</span></td>
              <td>${formatTokens(m.input)}</td>
              <td>${formatTokens(m.output)}</td>
              <td>${formatTokens(m.cacheWrite)}</td>
              <td>${formatTokens(m.cacheRead)}</td>
              <td class="cost-cell">${formatCost(m.cost)}</td>
              <td>${srcBadge(m.costSource)}</td>
              <td class="cumulative">${formatCost(m.cumulativeCost)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  requestAnimationFrame(() => {
    renderCumulativeChart(d.messages);
    renderTokenBreakdownChart(d.messages);
  });
}

// #endregion

// #region CHARTS

function getChartColors() {
  const style = getComputedStyle(document.body);
  return {
    accent: style.getPropertyValue('--accent').trim() || '#e86f33',
    chartFill: style.getPropertyValue('--chart-fill').trim() || 'rgba(232,111,51,0.6)',
    text: style.getPropertyValue('--text-secondary').trim() || '#c2c4c9',
    border: style.getPropertyValue('--border').trim() || '#363840',
    bg: style.getPropertyValue('--bg-elevated').trim() || '#1e2025',
    chart1: style.getPropertyValue('--chart-1').trim() || '#e86f33',
    chart2: style.getPropertyValue('--chart-2').trim() || '#60a5fa',
    chart3: style.getPropertyValue('--chart-3').trim() || '#3ecf8e',
    chart4: style.getPropertyValue('--chart-4').trim() || '#f0b429',
  };
}

function modelColor(name) {
  const isLight = isLightTheme();
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const sat = isLight ? 55 : 60;
  const light = isLight ? 50 : 62;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function chartDefaults() {
  const c = getChartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: c.bg, titleColor: c.text, bodyColor: c.text, borderColor: c.border, borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border, drawBorder: false } },
      y: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.border, drawBorder: false } },
    },
  };
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function renderDailyChart(daily, canvasId = 'dailyChart', chartKey = 'daily') {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !daily?.length) return;
  destroyChart(chartKey);
  const c = getChartColors();
  const defaults = chartDefaults();
  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: daily.map((d) => shortDate(d.date)),
      datasets: [{
        label: 'Daily Cost',
        data: daily.map((d) => d.cost),
        backgroundColor: c.accent,
        borderColor: c.accent,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      ...defaults,
      plugins: { ...defaults.plugins, tooltip: { ...defaults.plugins.tooltip, callbacks: { label: (ctx) => `$${ctx.parsed.y.toFixed(2)}` } } },
      scales: { ...defaults.scales, y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, callback: (v) => `$${v.toFixed(2)}` } } },
    },
  });
}

function renderModelChart(models, canvasId = 'modelChart', chartKey = 'model') {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !models?.length) return;
  destroyChart(chartKey);
  const defaults = chartDefaults();
  const total = models.reduce((s, m) => s + m.cost, 0);
  charts[chartKey] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: models.map((m) => shortModel(m.model)),
      datasets: [{
        data: models.map((m) => m.cost),
        backgroundColor: models.map((m) => modelColor(m.model)),
        borderWidth: 0,
        borderRadius: 3,
      }],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      plugins: {
        ...defaults.plugins,
        tooltip: { ...defaults.plugins.tooltip, callbacks: { label: (ctx) => `$${ctx.parsed.x.toFixed(2)} (${((ctx.parsed.x / total) * 100).toFixed(1)}%)` } },
      },
      scales: { ...defaults.scales, x: { ...defaults.scales.x, ticks: { ...defaults.scales.x.ticks, callback: (v) => `$${v}` } } },
    },
  });
}

function renderCumulativeChart(messages) {
  const canvas = document.getElementById('cumulativeChart');
  if (!canvas || !messages?.length) return;
  destroyChart('cumulative');
  const c = getChartColors();
  const defaults = chartDefaults();
  charts.cumulative = new Chart(canvas, {
    type: 'line',
    data: {
      labels: messages.map((_, i) => i + 1),
      datasets: [{
        label: 'Cumulative Cost',
        data: messages.map((m) => m.cumulativeCost),
        borderColor: c.accent,
        backgroundColor: c.chartFill,
        fill: true,
        borderWidth: 2,
        pointRadius: messages.length > 50 ? 0 : 3,
        pointBackgroundColor: c.accent,
        tension: 0.2,
      }],
    },
    options: {
      ...defaults,
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, title: { display: true, text: 'Message #', color: c.text, font: { size: 10 } } },
        y: { ...defaults.scales.y, ticks: { ...defaults.scales.y.ticks, callback: (v) => `$${v.toFixed(2)}` } },
      },
    },
  });
}

function renderTokenBreakdownChart(messages) {
  const canvas = document.getElementById('tokenBreakdownChart');
  if (!canvas || !messages?.length) return;
  destroyChart('tokenBreakdown');
  const c = getChartColors();
  const defaults = chartDefaults();
  charts.tokenBreakdown = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: messages.map((_, i) => i + 1),
      datasets: [
        { label: 'Input', data: messages.map((m) => m.input), backgroundColor: c.chart1, borderRadius: 2 },
        { label: 'Output', data: messages.map((m) => m.output), backgroundColor: c.chart2, borderRadius: 2 },
        { label: 'Cache Write', data: messages.map((m) => m.cacheWrite), backgroundColor: c.chart3, borderRadius: 2 },
        { label: 'Cache Read', data: messages.map((m) => m.cacheRead), backgroundColor: c.chart4, borderRadius: 2 },
      ],
    },
    options: {
      ...defaults,
      plugins: {
        ...defaults.plugins,
        legend: {
          display: true, position: 'bottom',
          labels: { color: c.text, font: { size: 10, family: "'IBM Plex Mono', monospace" }, padding: 8, boxWidth: 12, boxHeight: 12 },
        },
      },
      scales: {
        ...defaults.scales,
        x: { ...defaults.scales.x, stacked: true },
        y: { ...defaults.scales.y, stacked: true, ticks: { ...defaults.scales.y.ticks, callback: (v) => formatTokens(v) } },
      },
    },
  });
}

// #endregion

// #region THEME

const THEME_COLOR_TO_VAR = {
  bgDeep: '--bg-deep', bgSurface: '--bg-surface', bgElevated: '--bg-elevated', bgHover: '--bg-hover',
  border: '--border',
  textPrimary: '--text-primary', textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary', textMuted: '--text-muted',
  accent: '--accent', accentText: '--accent-text',
  success: '--success', warning: '--warning', error: '--error',
};

let _themeCache = { light: null, dark: null };

function _hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function _rgba(hex, a) {
  const rgb = _hexToRgb(hex);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})` : null;
}

function isLightTheme() {
  if (document.body.classList.contains('light')) return true;
  if (document.body.classList.contains('dark-forced')) return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function applyTheme(theme) {
  if (!theme || !theme.colors) return;
  const root = document.body.style;
  for (const [k, cssVar] of Object.entries(THEME_COLOR_TO_VAR)) {
    if (theme.colors[k]) root.setProperty(cssVar, theme.colors[k]);
  }
  const c = theme.colors;
  const isLight = theme.mode === 'light';
  const dimAlpha = isLight ? 0.15 : 0.18;
  const accentDimAlpha = isLight ? 0.18 : 0.22;
  const accentGlowAlpha = isLight ? 0.5 : 0.55;
  const accentFaintAlpha = isLight ? 0.06 : 0.05;
  const accentSoftAlpha = 0.12;
  const accentTagAlpha = 0.15;
  const chartFillAlpha = isLight ? 0.5 : 0.6;
  const set = (name, val) => val && root.setProperty(name, val);
  set('--accent-dim', _rgba(c.accent, accentDimAlpha));
  set('--accent-glow', _rgba(c.accent, accentGlowAlpha));
  set('--accent-faint', _rgba(c.accent, accentFaintAlpha));
  set('--accent-soft', _rgba(c.accent, accentSoftAlpha));
  set('--accent-tag', _rgba(c.accent, accentTagAlpha));
  set('--chart-fill', _rgba(c.accent, chartFillAlpha));
  set('--success-dim', _rgba(c.success, dimAlpha));
  set('--warning-dim', _rgba(c.warning, dimAlpha));
  set('--error-dim', _rgba(c.error, dimAlpha));
}

async function loadActiveThemes() {
  try {
    const res = await fetch('/api/themes');
    if (res.ok) {
      const data = await res.json();
      _themeCache = { light: data.light, dark: data.dark };
    }
  } catch {}
}

function applyCurrentThemeColors() {
  const t = isLightTheme() ? _themeCache.light : _themeCache.dark;
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
  const isCurrentlyLight = isLightTheme();
  if (isCurrentlyLight) {
    document.body.classList.remove('light');
    document.body.classList.add('dark-forced');
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.add('light');
    document.body.classList.remove('dark-forced');
    localStorage.setItem('theme', 'light');
  }
  applyCurrentThemeColors();
  updateThemeIcon();
  lastRenderHash = {};
  renderCurrentView();
}

function loadTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light');
    document.body.classList.remove('dark-forced');
  } else if (saved === 'dark') {
    document.body.classList.remove('light');
    document.body.classList.add('dark-forced');
  }
  // No saved pref — prefers-color-scheme CSS handles the initial paint.
  updateThemeIcon();
  loadActiveThemes().then(() => {
    applyCurrentThemeColors();
    lastRenderHash = {};
    renderCurrentView();
  });
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

  if (view === 'overview' || view === 'projects') {
    currentProjectDir = null;
    currentProjectName = null;
    currentSessionId = null;
  }
  if (view === 'sessions') {
    currentSessionId = null;
  }

  const navView = view === 'sessions' || view === 'detail' ? parentView : view;
  setActiveNav(navView);
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
  if (s.field === field) s.order = s.order === 'desc' ? 'asc' : 'desc';
  else { s.field = field; s.order = 'desc'; }
  lastRenderHash[currentView] = null;
  saveSort();
  updateUrl('replace');
  if (currentView === 'overview') renderOverview();
  else if (currentView === 'sessions') renderSessions();
  else renderProjects();
}

async function onRangeChange(val) {
  dateRange = val === 'today' ? 'today' : parseInt(val, 10) || 7;
  saveDateRange(dateRange);
  lastRenderHash = {};
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
    forceRefresh = true;
    lastRenderHash = {};
    overviewData = projectsData = sessionsData = sessionDetailData = null;
    await loadAndRender(currentView);
    forceRefresh = false;
    await minWait;
    showToast('Data refreshed', false, 'success');
  } finally {
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
  if (viewEl && !viewEl.querySelector('.dashboard-content')) {
    viewEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading...</span></div>';
  }

  try {
    switch (view) {
      case 'overview':
        await fetchOverview();
        if (myNav !== navCounter) return;
        renderOverview();
        break;
      case 'projects':
        await fetchProjects();
        if (myNav !== navCounter) return;
        renderProjects();
        break;
      case 'sessions':
        if (currentProjectDir) {
          await fetchSessions(currentProjectDir);
          if (myNav !== navCounter) return;
          renderSessions();
        }
        break;
      case 'detail':
        if (currentSessionId) {
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
    showToast(`Error: ${err.message}`);
    if (viewEl) viewEl.innerHTML = `<div class="loading-state"><span>Failed to load: ${esc(err.message)}</span></div>`;
  }
}

function renderCurrentView() { loadAndRender(currentView); }

function ensureViewElements() {
  const app = document.getElementById('app');
  if (!app) return;
  for (const v of ['overview', 'projects', 'sessions', 'detail']) {
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

function toggleHelpModal() {
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
  } else if (currentView === 'projects') {
    target = 'overview';
    await navigate('overview');
  }
  if (target) focusPreviousRow(target);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  const anyModal = document.querySelector('.modal-overlay.visible');
  if (anyModal) {
    if (e.key === 'Escape') { anyModal.classList.remove('visible'); e.preventDefault(); }
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); toggleHelpModal(); return; }
  if (e.key === '1') { e.preventDefault(); navigate('overview'); return; }
  if (e.key === '2') { e.preventDefault(); navigate('projects'); return; }
  if (e.key === 'r') { e.preventDefault(); refreshData(); return; }
  if (e.key === 't') { e.preventDefault(); toggleTheme(); return; }
  if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); goBack(); return; }

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
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateSelectedRow(); return; }
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

function dismissToast(el) { if (el) el.remove(); }

// #endregion

// #region PI_INTEGRATION

(async function initPi() {
  try {
    const cfg = await fetch('/pi-config').then((r) => r.json());
    window.__PI__ = cfg;
  } catch {}
})();

// #endregion

// #region PWA

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

// #endregion

// #region INIT

loadTheme();
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
  const rs = document.getElementById('rangeSelect');
  if (rs) rs.value = dateRange;

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
  } else if (state.view === 'projects') {
    await navigate('projects', undefined, 'replace');
  } else {
    await navigate('overview', undefined, 'replace');
  }
});

window.addEventListener('popstate', () => {
  const p = new URLSearchParams(window.location.search);
  currentView = p.get('view') || 'overview';
  parentView = p.get('parentView') || 'projects';
  currentProjectDir = p.get('project');
  currentProjectName = p.get('projectName');
  currentSessionId = p.get('session');
  lastRenderHash = {};
  sessionStorage.setItem('pi-cost:nav', p.toString());
  setActiveNav(currentView === 'sessions' || currentView === 'detail' ? parentView : currentView);
  loadAndRender(currentView);
});

// Expose for inline handlers
window.navigate = navigate;
window.navigateToSessions = navigateToSessions;
window.navigateToDetail = navigateToDetail;
window.sortBy = sortBy;
window.onRangeChange = onRangeChange;
window.refreshData = refreshData;
window.toggleTheme = toggleTheme;
window.toggleHelpModal = toggleHelpModal;

// #endregion
