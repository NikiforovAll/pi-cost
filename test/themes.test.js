const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createThemeStore } = require('../lib/themes');

const costDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-themes-'));
const userDir = path.join(costDir, 'themes');
fs.mkdirSync(userDir);

const colors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'themes', 'pi-dark.json'), 'utf8')).colors;
const write = (file, obj) => fs.writeFileSync(path.join(userDir, file), JSON.stringify(obj));
write('odd-light.json', { name: 7, displayName: ['x'], mode: 'light', colors });
write('odd-dark.json', { mode: 'dark', colors });
write('lonely-light.json', { mode: 'light', colors });
write('-light.json', { mode: 'light', colors });
write('-dark.json', { mode: 'dark', colors });
write('blank-dark.json', { mode: 'dark', colors: { ...colors, accent: ' ' } });

after(() => fs.rmSync(costDir, { recursive: true, force: true }));

describe('theme store', () => {
  it('pairs user themes into families and skips broken ones', async () => {
    const store = createThemeStore(costDir);
    await store.ready;
    const ids = store.families().map((f) => f.id);
    assert.ok(ids.includes('odd'));
    assert.ok(!ids.includes('lonely'));
    assert.ok(!ids.includes(''));
    assert.equal(store.families().find((f) => f.id === 'odd').displayName, 'odd');
    assert.equal(store.themes.has('blank-dark'), false);
  });
});
