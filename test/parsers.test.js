const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parsers = require('../lib/pi-parsers-cost');
const { IDS, buildFixture } = require('./helpers/fixtures');

const fx = buildFixture();
after(() => fs.rmSync(fx.base, { recursive: true, force: true }));

const lc = (p) => p.toLowerCase();
const nestedDir = lc(path.join(parsers.longPath(fx.agentDir), 'sessions'));

describe('resolveRoots', () => {
  it('uses PI_CODING_AGENT_DIR and its nested sessions dir', () => {
    const { agentDir, roots } = parsers.resolveRoots({ env: { PI_CODING_AGENT_DIR: fx.agentDir } });
    assert.equal(lc(agentDir), lc(parsers.longPath(fx.agentDir)));
    assert.deepEqual(roots.map((r) => [lc(r.dir), r.flat]), [[nestedDir, false]]);
  });

  it('falls back to <PI_DIR>/agent', () => {
    const { agentDir } = parsers.resolveRoots({ env: { PI_DIR: fx.base } });
    assert.equal(lc(agentDir), lc(parsers.longPath(path.join(fx.base, 'agent'))));
  });

  it('puts --session-dir first as a flat root and keeps the nested dir', () => {
    const { roots } = parsers.resolveRoots({ env: { PI_CODING_AGENT_DIR: fx.agentDir, PI_CODING_AGENT_SESSION_DIR: os.tmpdir() }, sessionDir: fx.flatDir });
    assert.deepEqual(roots.map((r) => [lc(r.dir), r.flat]), [[lc(parsers.longPath(fx.flatDir)), true], [nestedDir, false]]);
  });

  it('takes PI_CODING_AGENT_SESSION_DIR over settings.sessionDir', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-settings-'));
    try {
      fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: os.tmpdir() }));
      const { roots } = parsers.resolveRoots({ env: { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: fx.flatDir } });
      assert.equal(lc(roots[0].dir), lc(parsers.longPath(fx.flatDir)));
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('reads an absolute settings.sessionDir and ignores a relative one', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-settings-'));
    const settings = path.join(agentDir, 'settings.json');
    try {
      fs.writeFileSync(settings, JSON.stringify({ sessionDir: fx.flatDir }));
      let { roots } = parsers.resolveRoots({ env: { PI_CODING_AGENT_DIR: agentDir } });
      assert.equal(roots.length, 2);
      assert.equal(roots[0].flat, true);
      fs.writeFileSync(settings, JSON.stringify({ sessionDir: 'relative/sessions' }));
      ({ roots } = parsers.resolveRoots({ env: { PI_CODING_AGENT_DIR: agentDir } }));
      assert.equal(roots.length, 1);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('does not list the nested dir twice when the custom dir is the same', () => {
    const { roots } = parsers.resolveRoots({ env: { PI_CODING_AGENT_DIR: fx.agentDir }, sessionDir: path.join(fx.agentDir, 'sessions') });
    assert.equal(roots.length, 1);
  });
});

describe('paths', () => {
  it('longPath keeps a missing tail and resolves the existing head', () => {
    const missing = path.join(fx.base, 'no', 'such', 'dir');
    assert.equal(lc(parsers.longPath(missing)), lc(path.join(fs.realpathSync.native(fx.base), 'no', 'such', 'dir')));
  });

  it('normalizePiPath expands ~', () => {
    assert.equal(parsers.normalizePiPath('~'), os.homedir());
    assert.equal(parsers.normalizePiPath('~/x'), path.join(os.homedir(), 'x'));
  });

  it('normalizePiPath reads Git Bash drive paths on Windows', { skip: process.platform !== 'win32' }, () => {
    assert.equal(parsers.normalizePiPath('/c/Users/me'), 'C:\\Users\\me');
    assert.equal(parsers.normalizePiPath('/mnt/d/x'), 'D:\\x');
  });

  it('encodes and decodes a Windows project dir', () => {
    assert.equal(parsers.encodeProjectDir('C:\\Users\\foo\\bar'), '--C--Users-foo-bar--');
    assert.equal(parsers.decodeProjectDir('--C--Users-foo-bar--'), 'C:\\Users\\foo\\bar');
    assert.equal(parsers.decodeProjectDir('--home-foo--'), '/home/foo');
  });

  it('slugFromFile takes the part after the timestamp', () => {
    assert.equal(parsers.slugFromFile(fx.files.alpha), IDS.alpha);
  });
});

describe('listing', () => {
  it('lists nested and flat sessions, not the nested subagent runs', async () => {
    parsers.configure({ env: { PI_CODING_AGENT_DIR: fx.agentDir }, sessionDir: fx.flatDir });
    const files = await parsers.listSessionFiles();
    const ids = files.map((f) => parsers.slugFromFile(f.file)).sort();
    assert.deepEqual(ids, [IDS.alpha, IDS.beta, IDS.gamma].sort());
    const gamma = files.find((f) => parsers.slugFromFile(f.file) === IDS.gamma);
    assert.equal(gamma.projectDir, fx.projects.gamma);
  });

  it('lists nested subagent runs apart', async () => {
    const nested = await parsers.listNestedSubagentFiles();
    assert.equal(nested.length, 1);
    assert.equal(nested[0].runId, 'run-1');
    assert.equal((await parsers.readSessionHeader(nested[0].file)).id, IDS.run);
  });
});

describe('enumerators', () => {
  const entries = () => parsers.readSessionEntriesUncached(fx.files.alpha);

  it('yields one row per assistant turn plus the compaction with usage', async () => {
    const rows = [...parsers.enumerateMessageUsages(await entries())];
    assert.equal(rows.length, fx.expected.alphaTurns + 1);
    const c = rows.find((r) => r.compaction);
    assert.equal(c.compaction.tokensBefore, 50000);
    assert.equal(c.model, 'gpt-6-luna');
    assert.deepEqual(rows[0].tools, ['read', 'bash']);
  });

  it('yields compaction events and subagent runs', async () => {
    const e = await entries();
    assert.deepEqual([...parsers.enumerateCompactions(e)].map((c) => c.hasUsage), [true]);
    const [run] = [...parsers.enumerateSubagentRuns(e)];
    assert.equal(run.agent, 'scout');
    assert.equal(run.turns, 2);
    assert.equal(run.jsonlPath, fx.files.run);
  });

  it('summarize keeps pi-kanban field names', async () => {
    const s = parsers.summarize(await entries());
    assert.equal(s.customTitle, 'Alpha work');
    assert.equal(s.assistantCount, fx.expected.alphaTurns);
    for (const k of ['totalInput', 'totalOutput', 'totalCacheRead', 'totalCacheWrite']) assert.equal(typeof s[k], 'number', k);
  });
});
