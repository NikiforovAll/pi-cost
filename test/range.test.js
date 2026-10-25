const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const costs = require('../lib/costs');

const today = costs.localDateStr(new Date());

describe('parseRange', () => {
  it('reads presets, day counts and all time', () => {
    assert.equal(costs.parseRange('today'), 'today');
    assert.equal(costs.parseRange('24h'), '24h');
    assert.equal(costs.parseRange('7'), 7);
    assert.equal(costs.parseRange('1'), 'today');
    assert.equal(costs.parseRange('all', 30), null);
    assert.equal(costs.parseRange('0', 30), null);
  });

  it('falls back on junk and caps huge counts', () => {
    assert.equal(costs.parseRange('week', 30), 30);
    assert.equal(costs.parseRange(undefined, 30), 30);
    assert.equal(costs.parseRange('99999'), 3660);
  });
});

describe('parseCustomRange', () => {
  it('is undefined when no window was asked for', () => {
    assert.equal(costs.parseCustomRange({}), undefined);
  });

  it('is null for a malformed or half pair', () => {
    assert.equal(costs.parseCustomRange({ from: '2026-02-30', to: '2026-03-01' }), null);
    assert.equal(costs.parseCustomRange({ from: '2026-01-01' }), null);
    assert.equal(costs.parseCustomRange({ from: 'x', to: '2026-01-01' }), null);
  });

  it('orders a reversed pair and clamps to today', () => {
    assert.deepEqual(costs.parseCustomRange({ from: '2026-01-10', to: '2026-01-01' }), { from: '2026-01-01', to: '2026-01-10' });
    assert.deepEqual(costs.parseCustomRange({ from: '2026-01-01', to: '2999-01-01' }), { from: '2026-01-01', to: today });
  });
});

describe('parseProject', () => {
  it('rejects control characters and overlong values', () => {
    assert.equal(costs.parseProject(undefined), undefined);
    assert.equal(costs.parseProject('--C--x--'), '--C--x--');
    assert.equal(costs.parseProject('a\u0000b'), null);
    assert.equal(costs.parseProject('x'.repeat(1025)), null);
  });
});

describe('resolveWindow', () => {
  const now = new Date(2026, 5, 15, 14, 30);

  it('N days ends today and starts at local midnight', () => {
    const w = costs.resolveWindow(7, now);
    assert.equal(costs.localDateStr(w.cutoff), '2026-06-09');
    assert.equal(w.cutoff.getHours(), 0);
    assert.equal(w.endStr, null);
    assert.equal(w.hasToday, true);
  });

  it('a custom window has a closed end', () => {
    const w = costs.resolveWindow({ from: '2026-06-01', to: '2026-06-03' }, now);
    assert.equal(costs.localDateStr(w.cutoff), '2026-06-01');
    assert.equal(w.end.getHours(), 23);
    assert.ok(w.endStr);
    assert.equal(w.hasToday, false);
  });

  it('all time has no cutoff', () => {
    assert.equal(costs.resolveWindow(null, now).cutoff, null);
  });
});

describe('rangeBucket', () => {
  it('uses hours for one day and days otherwise', () => {
    assert.equal(costs.rangeBucket('today'), 'hour');
    assert.equal(costs.rangeBucket('24h'), 'hour');
    assert.equal(costs.rangeBucket(7), 'day');
    assert.equal(costs.rangeBucket({ from: '2026-01-01', to: '2026-01-01' }), 'hour');
    assert.equal(costs.rangeBucket({ from: '2026-01-01', to: '2026-01-02' }), 'day');
  });
});

describe('filterWindow', () => {
  const msgs = [{ ts: '2026-01-01T00:00:00Z' }, { ts: '2026-01-02T00:00:00Z' }, { ts: null }];

  it('keeps everything with no bounds and drops rows outside them', () => {
    assert.equal(costs.filterWindow(msgs, null, null).length, 3);
    assert.deepEqual(costs.filterWindow(msgs, '2026-01-01T12:00:00Z', null), [msgs[1]]);
    assert.deepEqual(costs.filterWindow(msgs, null, '2026-01-01T12:00:00Z'), [msgs[0]]);
  });
});

describe('buildCostSeries', () => {
  it('gap-fills empty days and sums each bucket from its models', () => {
    const start = new Date(2026, 0, 1);
    const end = new Date(2026, 0, 3, 12);
    const points = costs.buildCostSeries({ '2026-01-01': { a: 1, b: 2 }, '2026-01-03': { a: 0.5 } }, start, end, 'day');
    assert.deepEqual(points.map((p) => [p.key, p.cost]), [['2026-01-01', 3], ['2026-01-02', 0], ['2026-01-03', 0.5]]);
  });

  it('is empty with no cost at all', () => {
    assert.deepEqual(costs.buildCostSeries({}, new Date(), new Date(), 'day'), []);
  });

  it('draws 24 hour buckets for a day', () => {
    const start = new Date(2026, 0, 1);
    const end = new Date(2026, 0, 1, 23, 59);
    assert.equal(costs.buildCostSeries({ '2026-01-01T05': { a: 1 } }, start, end, 'hour').length, 24);
  });
});

describe('computeBlocks', () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m).toISOString();
  const row = (ts, cost) => ({ ts, cost, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, model: 'm' });

  it('opens a 5 h block at the hour of the first row, newest first', () => {
    const blocks = costs.computeBlocks([row(at(9, 40), 1), row(at(13, 59), 2), row(at(14, 0), 4)]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].start, at(9));
    assert.equal(blocks[1].cost, 3);
    assert.equal(blocks[1].messageCount, 2);
    assert.equal(blocks[0].start, at(14));
    assert.equal(blocks[0].tokens, 2);
  });
});
