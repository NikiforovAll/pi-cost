'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readCostSettings } = require('./cost-dir');

const BUILTIN_THEME_DIR = path.join(__dirname, '..', 'themes');

// The same 14 keys the pi-kanban embed handshake sends in `pi-companion:theme`.
const REQUIRED_COLOR_KEYS = [
  'bgDeep', 'bgSurface', 'bgElevated', 'bgHover',
  'border',
  'textPrimary', 'textSecondary', 'textTertiary', 'textMuted',
  'accent', 'accentText',
  'success', 'warning', 'error',
];

// Precedence: env > <costDir>/settings.json > defaults.
function themeConfig(costDir, env = process.env) {
  const fromSettings = readCostSettings(costDir).themes || {};
  return {
    dir: env.COST_THEME_DIR || fromSettings.dir || path.join(costDir, 'themes'),
    lightId: env.COST_LIGHT_THEME || fromSettings.light || 'pi-light',
    darkId: env.COST_DARK_THEME || fromSettings.dark || 'pi-dark',
  };
}

async function loadThemesFromDir(dir, builtin, into) {
  let entries;
  try { entries = await fsp.readdir(dir); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`themes: cannot read ${dir}: ${e.message}`);
    return;
  }
  await Promise.all(entries.filter((f) => f.toLowerCase().endsWith('.json')).map(async (f) => {
    const full = path.join(dir, f);
    const id = f.replace(/\.json$/i, '');
    try {
      const obj = JSON.parse(await fsp.readFile(full, 'utf8'));
      if (obj.mode !== 'light' && obj.mode !== 'dark') {
        console.warn(`themes: skip ${full}: invalid mode`);
        return;
      }
      const colors = obj.colors || {};
      const missing = REQUIRED_COLOR_KEYS.filter((k) => typeof colors[k] !== 'string' || !colors[k].trim());
      if (missing.length) {
        console.warn(`themes: skip ${full}: missing colors ${missing.join(',')}`);
        return;
      }
      const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
      const name = str(obj.name) || id;
      into.set(id, { id, name, displayName: str(obj.displayName) || name, mode: obj.mode, colors, builtin });
    } catch (e) {
      console.warn(`themes: skip ${full}: ${e.message}`);
    }
  }));
}

function createThemeStore(costDir) {
  const config = themeConfig(costDir);
  const themes = new Map();
  const ready = (async () => {
    await loadThemesFromDir(BUILTIN_THEME_DIR, true, themes);
    await loadThemesFromDir(config.dir, false, themes);
  })();

  function active(mode) {
    const id = mode === 'light' ? config.lightId : config.darkId;
    return themes.get(id) || themes.get(mode === 'light' ? 'pi-light' : 'pi-dark') || null;
  }

  // A family is a `<id>-light` / `<id>-dark` pair; the theme menu offers families, not single themes.
  function families() {
    const out = [];
    for (const light of themes.values()) {
      if (light.mode !== 'light' || !light.id.endsWith('-light')) continue;
      const id = light.id.slice(0, -'-light'.length);
      if (!id) continue;
      const dark = themes.get(`${id}-dark`);
      if (dark?.mode !== 'dark') continue;
      out.push({ id, displayName: light.displayName.replace(/[\s_-]+light$/i, ''), light, dark });
    }
    const rank = (f) => (f.id === 'pi' ? 0 : f.id === 'classic' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
  }

  return { config, themes, ready, active, families };
}

module.exports = { REQUIRED_COLOR_KEYS, createThemeStore };
