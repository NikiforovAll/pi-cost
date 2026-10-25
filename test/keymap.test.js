const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const groups = /^const SHORTCUT_GROUPS = [\s\S]*?^\];/m.exec(src)[0];
const keyViews = /^const KEY_VIEWS = .*;$/m.exec(src)[0];
const handler = /^document\.addEventListener\('keydown', [\s\S]*?^\}\);/m.exec(src)[0];

const page = vm.runInNewContext(
  `${fn('esc')}\n${groups}\n${keyViews}\n${fn('buildHelpShortcuts')}\n({ SHORTCUT_GROUPS, KEY_VIEWS, buildHelpShortcuts })`,
  {},
);
const rows = page.SHORTCUT_GROUPS.flatMap((g) => g.rows);

describe('help dialog', () => {
  it('renders every group and row', () => {
    const html = page.buildHelpShortcuts();
    for (const g of page.SHORTCUT_GROUPS) assert.match(html, new RegExp(`<h4 class="shortcut-section">${g.title}</h4>`));
    for (const r of rows) assert.ok(html.includes(`<td>${r.label}</td>`), r.label);
    assert.match(html, /<kbd>Shift<\/kbd> \+ <kbd>←\/→<\/kbd>/);
  });

  it('the view keys match KEY_VIEWS', () => {
    const nav = page.SHORTCUT_GROUPS.find((g) => g.title === 'Navigation').rows;
    for (const [key, view] of Object.entries(page.KEY_VIEWS)) {
      const row = nav.find((r) => r.keys.includes(key));
      assert.ok(row, key);
      assert.equal(row.label.toLowerCase(), view);
    }
  });

  it('every single-letter key has a branch in the keydown handler', () => {
    const letters = rows.flatMap((r) => r.keys).filter((k) => /^[A-Z?]$/.test(k));
    for (const k of letters) {
      const key = k === '?' ? '?' : k.toLowerCase();
      assert.ok(handler.includes(`e.key === '${key}'`), `no handler for ${k}`);
    }
  });
});
