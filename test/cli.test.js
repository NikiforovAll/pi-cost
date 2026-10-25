const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../lib/cli');
const { getArg, hasFlag } = require('../lib/args');
const { IDS, buildFixture } = require('./helpers/fixtures');

const fx = buildFixture();
after(() => fs.rmSync(fx.base, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', 'server.js');
const env = { ...process.env, PI_CODING_AGENT_DIR: fx.agentDir, PI_CODING_AGENT_SESSION_DIR: fx.flatDir, PI_COST_OFFLINE: '1' };
delete env.COST_URL;
delete env.PI_COST_RANGE;

const run = (...args) => spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 30_000 });

function costDir(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-cli-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

function windowOf(flags, { settings, env: e = {} } = {}) {
  const warnings = [];
  const w = cli.resolveWindow(flags, { costDir: costDir(settings), env: e, warn: (s) => warnings.push(s) });
  return { w, warnings };
}

describe('args', () => {
  it('reads --name value and --name=value, not a following flag', () => {
    assert.equal(getArg('port', ['node', 's', '--port', '0']), '0');
    assert.equal(getArg('port', ['node', 's', '--port=5']), '5');
    assert.equal(getArg('port', ['node', 's', '--port', '--no-open']), null);
    assert.equal(hasFlag('no-open', ['node', 's', '--no-open']), true);
  });
});

describe('parseWindowValue', () => {
  it('reads presets and day counts', () => {
    assert.equal(cli.parseWindowValue('today').range, 'today');
    assert.equal(cli.parseWindowValue('24h').range, '24h');
    assert.equal(cli.parseWindowValue('7d').range, 7);
    assert.equal(cli.parseWindowValue('30').range, 30);
  });

  it('rejects all time, zero and more than a year', () => {
    for (const v of ['all', '0', '0d', '366d', 'week', '']) assert.equal(cli.parseWindowValue(v), null, v);
  });
});

describe('resolveWindow', () => {
  it('defaults to 7 days', () => {
    const { w } = windowOf({});
    assert.equal(w.range, 7);
    assert.equal(w.source, 'default');
  });

  it('takes the flag, then PI_COST_RANGE, then cli.defaultRange', () => {
    const settings = { cli: { defaultRange: '30d' } };
    assert.equal(windowOf({ range: 'today' }, { settings, env: { PI_COST_RANGE: '90d' } }).w.range, 'today');
    assert.equal(windowOf({}, { settings, env: { PI_COST_RANGE: '90d' } }).w.source, 'PI_COST_RANGE');
    assert.equal(windowOf({}, { settings }).w.source, 'cli.defaultRange');
  });

  it('skips a bad env or settings value with a warning, fails on a bad flag', () => {
    const { w, warnings } = windowOf({}, { settings: { cli: { defaultRange: 'all' } }, env: { PI_COST_RANGE: 'soon' } });
    assert.equal(w.range, 7);
    assert.equal(warnings.length, 2);
    assert.throws(() => windowOf({ range: '400d' }), /--range 400d/);
  });

  it('takes a from/to pair over --range', () => {
    const { w } = windowOf({ range: '7d', from: '2026-01-10', to: '2026-01-01' });
    assert.deepEqual(w.range, { from: '2026-01-01', to: '2026-01-10' });
    assert.equal(w.days, 10);
    assert.equal(w.query, 'from=2026-01-01&to=2026-01-10');
  });
});

describe('previousWindow', () => {
  it('is the same number of days ending the day before', () => {
    const now = new Date(2026, 5, 15, 12);
    const prev = cli.previousWindow({ range: 7, days: 7 }, now);
    assert.deepEqual(prev.range, { from: '2026-06-02', to: '2026-06-08' });
  });

  it('has nothing before 24h', () => {
    assert.throws(() => cli.previousWindow({ range: '24h', days: 1 }), /--compare/);
  });
});

describe('findServer', () => {
  const roots = [{ dir: 'C:\\x', flat: false }];

  it('prefers COST_URL', () => {
    assert.equal(cli.findServer(costDir(), { COST_URL: 'http://localhost:1/' }, roots), 'http://localhost:1');
  });

  it('reads a live server.json with the same roots', () => {
    const dir = costDir();
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: process.pid, port: 5999, sessionRoots: roots }));
    assert.equal(cli.findServer(dir, {}, roots), 'http://localhost:5999');
    assert.equal(cli.findServer(dir, {}, [{ dir: 'C:\\other', flat: true }]), null);
  });

  it('ignores a dead pid', () => {
    const dir = costDir();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: Number(dead), port: 5999 }));
    assert.equal(cli.findServer(dir, {}, roots), null);
  });
});

describe('helpers', () => {
  it('parseArgs splits flags and positionals', () => {
    assert.deepEqual(cli.parseArgs(['proj', '--range', '7d', '--json', '--top=3']), { flags: { range: '7d', json: true, top: '3' }, positional: ['proj'] });
  });

  it('matchSessions matches the title or first prompt, ignoring case', () => {
    const d = { sessions: [{ customTitle: 'Refactor X' }, { firstUserText: 'fix bug' }] };
    assert.equal(cli.matchSessions(d, 'refactor').sessions.length, 1);
  });

  it('resolveProject takes an exact dir, then one name match', () => {
    const list = [{ name: 'pi-cost', projectDir: 'a' }, { name: 'pi-kanban', projectDir: 'b' }];
    assert.equal(cli.resolveProject(list, 'b').name, 'pi-kanban');
    assert.equal(cli.resolveProject(list, 'cost').projectDir, 'a');
    assert.throws(() => cli.resolveProject(list, 'pi'), /matches 2 projects/);
  });

  it('isCommand knows the commands and help', () => {
    for (const c of ['overview', 'insights', 'projects', 'sessions', 'agents', 'session', 'help', '--help']) assert.equal(cli.isCommand(c), true, c);
    assert.equal(cli.isCommand('--port'), false);
    assert.equal(cli.isCommand(undefined), false);
  });
});

describe('pi-cost <command> without a server', () => {
  it('overview --json parses the session files', () => {
    const r = run('overview', '--range', '30d', '--json');
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.equal(d.summary.totalSessions, 3);
  });

  it('session <id> prints the totals', () => {
    const r = run('session', IDS.alpha);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Alpha work/);
  });

  it('sessions --project filters by name', () => {
    const r = run('sessions', '--range', '30d', '--project', 'gamma', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).sessions.map((s) => s.id), [IDS.gamma]);
  });

  it('an unknown session exits 1', () => {
    const r = run('session', 'nope');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Session not found/);
  });

  it('help lists every command', () => {
    const r = run('help');
    assert.equal(r.status, 0);
    for (const c of ['overview', 'insights', 'projects', 'sessions', 'agents', 'session']) assert.match(r.stdout, new RegExp(`\\n  ${c}\\b`));
  });
});
