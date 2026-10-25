'use strict';

const express = require('express');
const path = require('node:path');
const parsers = require('./pi-parsers-cost');
const pricing = require('./pi-pricing');
const costs = require('./costs');

const VERSION = require('../package.json').version;
// Served from node_modules, not a CDN: the page must work offline inside the pi-kanban board.
const CHART_JS = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');

/**
 * @param {{net: ReturnType<import('./net-guard').createNetGuard>, themes: ReturnType<import('./themes').createThemeStore>}} deps
 */
function createApp({ net, themes }) {
  const app = express();

  // Before express.json() so a rejected request never buffers a body.
  app.use(net.hostGuard);
  app.use(net.frameGuard);
  app.use(net.originGuard);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/vendor/chart.umd.min.js', (_req, res) => res.sendFile(CHART_JS));

  // A custom from/to wins over `range`. null is the all-time range, so malformed input is rejected
  // here rather than passed on as a sentinel.
  const withRange = (fallback = null) => (req, res, next) => {
    const custom = costs.parseCustomRange(req.query);
    if (custom === null) return res.status(400).json({ error: 'Invalid date range' });
    req.range = custom || costs.parseRange(req.query.range, fallback);
    next();
  };

  const withProject = (req, res, next) => {
    const project = costs.parseProject(req.query.project);
    if (project === null) return res.status(400).json({ error: 'Invalid project' });
    req.project = project;
    next();
  };

  const handle = (label, fn) => async (req, res) => {
    try {
      const data = await fn(req);
      if (data == null) return res.status(404).json({ error: `${label} not found` });
      res.json(data);
    } catch (err) {
      console.error(`[api] ${label}:`, err);
      res.status(500).json({ error: `Failed to load ${label}` });
    }
  };

  app.get('/api/themes', async (_req, res) => {
    await themes.ready;
    res.json({
      light: themes.active('light'),
      dark: themes.active('dark'),
      families: themes.families(),
      config: { lightId: themes.config.lightId, darkId: themes.config.darkId, themeDir: themes.config.dir },
    });
  });

  // pi-kanban probes this before it frames the page; `session` is the deep-link template.
  app.get('/api/companion', (_req, res) => {
    res.json({ name: 'pi-cost', version: VERSION, session: '/?session={id}' });
  });

  app.get('/pi-config', (req, res) => {
    res.json({
      agentDir: parsers.getAgentDir(),
      sessionsDir: parsers.getSessionsDir(),
      sessionRoots: parsers.getSessionRoots(),
      port: req.socket.localPort,
    });
  });

  app.get('/api/overview', withRange(30), withProject, handle('overview', (req) => costs.getOverviewData(req.range, req.project)));
  app.get('/api/insights', withRange(30), withProject, handle('insights', (req) => costs.getInsightsData(req.range, req.project)));
  app.get('/api/projects', withRange(), handle('projects', (req) => costs.getProjectsData(req.range)));
  app.get('/api/projects/:encoded/sessions', withRange(), handle('project sessions', (req) => costs.getProjectSessionsData(req.params.encoded, req.range)));
  app.get('/api/sessions', withRange(), withProject, handle('sessions', (req) => costs.getAllSessionsData(req.range, req.project)));
  app.get('/api/agents', withRange(30), withProject, handle('agents', (req) => costs.getAgentsData(req.range, req.project)));
  app.get('/api/sessions/:id', withRange(), handle('session', async (req) => {
    const base = await costs.getSessionDetailData(req.params.id);
    return base && costs.withSessionSlices(base, req.range);
  }));

  app.get('/api/pricing', handle('pricing', async () => {
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
    return { models, ...pricing.getMeta() };
  }));

  app.post('/api/refresh', (_req, res) => {
    costs.invalidateAllCache();
    pricing.refresh();
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp, VERSION };
