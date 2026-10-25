process.env.PI_COST_OFFLINE = '1';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const parsers = require('../lib/pi-parsers-cost');
const { createApp, VERSION } = require('../lib/app');
const { createNetGuard, FRAME_CSP } = require('../lib/net-guard');
const { createThemeStore } = require('../lib/themes');
const { IDS, buildFixture } = require('./helpers/fixtures');

const fx = buildFixture();
let server;
let base;

before(async () => {
  parsers.configure({ env: { PI_CODING_AGENT_DIR: fx.agentDir }, sessionDir: fx.flatDir });
  const net = createNetGuard({ appName: 'pi-cost', bindHost: '127.0.0.1' });
  const themes = createThemeStore(path.join(fx.agentDir, 'cost'));
  server = http.createServer(createApp({ net, themes }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(fx.base, { recursive: true, force: true });
});

const get = async (url, headers) => {
  const res = await fetch(base + url, { headers });
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('companion contract', () => {
  it('GET /api/companion names the app and the session template', async () => {
    const { status, body } = await get('/api/companion');
    assert.equal(status, 200);
    assert.deepEqual(body, { name: 'pi-cost', version: VERSION, session: '/?session={id}' });
  });

  it('every response lets a localhost board frame the page', async () => {
    const { headers } = await get('/');
    assert.equal(headers.get('content-security-policy'), FRAME_CSP);
    assert.match(FRAME_CSP, /frame-ancestors 'self' http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/);
  });

  it('serves the page assets offline', async () => {
    for (const url of ['/', '/app.js', '/style.css', '/fonts/fonts.css', '/vendor/chart.umd.min.js']) {
      assert.equal((await get(url)).status, 200, url);
    }
  });
});

describe('net guard', () => {
  it('rejects a foreign Host header', async () => {
    const status = await new Promise((resolve) => {
      http.get(`${base}/api/overview`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
    assert.equal(status, 403);
  });

  it('rejects a cross-origin POST and accepts a same-origin one', async () => {
    const evil = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    const ok = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base } });
    assert.equal(ok.status, 200);
  });
});

describe('cost API', () => {
  it('overview totals recorded and priced rows, nested runs once', async () => {
    const { status, body } = await get('/api/overview?range=30');
    assert.equal(status, 200);
    assert.equal(body.summary.totalSessions, 3);
    assert.equal(body.summary.sourceCounts.pricing, 1);
    const priced = body.summary.totalCost - fx.expected.recordedCost;
    assert.ok(priced > 0, 'the github-copilot turn gets a LiteLLM estimate');
    assert.equal(body.costSeries.bucket, 'day');
    assert.equal(body.costSeries.points.length, 30);
    near(body.costSeries.points.reduce((s, p) => s + p.cost, 0), body.summary.totalCost);
  });

  it('session detail matches a recount of the file', async () => {
    const { body } = await get(`/api/sessions/${IDS.alpha}?range=30`);
    near(body.totalCost, fx.expected.alphaCost);
    assert.equal(body.messageCount, fx.expected.alphaTurns + 2);
    assert.equal(body.customTitle, 'Alpha work');
    assert.equal(body.compactions.count, 1);
    near(body.compactions.totalCost, fx.expected.compactionCost);
    assert.equal(body.subagentCount, 1);
    near(body.subagentCost, fx.expected.runCost);
    const run = body.messages.find((m) => m.subagent);
    assert.equal(run.subagent.sessionId, IDS.run);
    assert.deepEqual(body.childSessions.map((c) => c.id), [IDS.beta]);
    near(body.messages.at(-1).cumulativeCost, fx.expected.alphaCost);
    near(body.inRange.totalCost, fx.expected.alphaCost);
  });

  it('a fork links to its parent and a nested run opens by id', async () => {
    const beta = (await get(`/api/sessions/${IDS.beta}`)).body;
    assert.equal(beta.parent.id, IDS.alpha);
    assert.equal(beta.messages[0].costSource, 'pricing');
    const run = await get(`/api/sessions/${IDS.run}`);
    assert.equal(run.status, 200);
    near(run.body.totalCost, fx.expected.runCost);
  });

  it('sessions roll up fork cost on the parent and filter by project', async () => {
    const all = (await get('/api/sessions?range=30')).body.sessions;
    assert.equal(all.length, 3);
    const alpha = all.find((s) => s.id === IDS.alpha);
    assert.deepEqual(alpha.childIds, [IDS.beta]);
    const only = (await get(`/api/sessions?range=30&project=${encodeURIComponent(fx.projects.gamma)}`)).body.sessions;
    assert.deepEqual(only.map((s) => s.id), [IDS.gamma]);
    near(only[0].totalCost, fx.expected.gammaCost);
  });

  it('project sessions use the pre-aggregated project', async () => {
    const { body } = await get(`/api/projects/${encodeURIComponent(fx.projects.alpha)}/sessions?range=30`);
    assert.equal(body.sessions.length, 1);
    near(body.project.totalCost, fx.expected.alphaCost);
  });

  it('agents group subagent runs', async () => {
    const { body } = await get('/api/agents?range=30');
    assert.deepEqual(body.agents.map((a) => [a.name, a.runs]), [['scout', 1]]);
    assert.equal(body.agents[0].costliest.runSessionId, IDS.run);
  });

  it('insights split main and subagent cost and count tools', async () => {
    const { body } = await get('/api/insights?range=30');
    near(body.subagents.subagentCost, fx.expected.runCost);
    assert.equal(body.subagents.runs, 1);
    assert.deepEqual(body.tools.map((t) => t.name).sort(), ['bash', 'read']);
    assert.equal(body.heatmap.length, 7);
    assert.ok(body.blocks.length >= 1);
    assert.equal(body.compactions.count, 1);
  });

  it('a custom window outside the data is empty', async () => {
    const { status, body } = await get('/api/overview?from=2020-01-01&to=2020-01-02');
    assert.equal(status, 200);
    assert.equal(body.summary.totalSessions, 0);
  });

  it('rejects a bad window and a bad project, 404s an unknown session', async () => {
    assert.equal((await get('/api/overview?from=2026-13-01&to=2026-01-01')).status, 400);
    assert.equal((await get('/api/sessions?project=a%00b')).status, 400);
    assert.equal((await get('/api/sessions/nope')).status, 404);
  });

  it('pi-config reports the agent dir and both roots', async () => {
    const { body } = await get('/pi-config');
    assert.equal(body.sessionRoots.length, 2);
    assert.equal(body.sessionRoots[0].flat, true);
    assert.equal(body.port, server.address().port);
  });

  it('themes answer with both modes', async () => {
    const { body } = await get('/api/themes');
    assert.ok(body.light.colors.accent);
    assert.ok(body.dark.colors.accent);
  });

  it('themes pair light and dark into families, pi first', async () => {
    const { body } = await get('/api/themes');
    assert.equal(body.families[0].id, 'pi');
    assert.equal(body.families[1].id, 'classic');
    for (const f of body.families) {
      assert.equal(f.light.mode, 'light', f.id);
      assert.equal(f.dark.mode, 'dark', f.id);
      assert.equal(f.light.id, `${f.id}-light`);
    }
    assert.ok(body.families.length >= 18);
  });
});
