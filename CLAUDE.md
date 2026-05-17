# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps (`express`, `open`).
- `npm start` — run server at `http://localhost:3461`.
- `npm run dev` — same, auto-opens browser.
- No test/lint scripts; verify changes by curling endpoints and watching server logs.
- As a pi extension: `pi --add ./extensions`, then `/cost start|stop|restart|status|open`.

## Architecture

**Data flow:** `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` → `lib/pi-parsers-cost.js` (streaming JSONL parse + LRU cache, cap 200) → `server.js` `buildAll()` (single pass, 8-way concurrent file reads) → in-memory 30s cache → REST API → vanilla-JS SPA (`public/app.js`).

**Cost model — critical:** pi messages carry `usage.cost.total` only for `dial` / `exa` providers; `github-copilot` / `auto` come back zero (subscription billing). Per-message fallback chain:
1. `usage.cost.total > 0` → `costSource: 'jsonl'` (actual)
2. else `lib/pi-pricing.js` `estimate(provider, model, usage)` against LiteLLM pricing (6h refresh, offline fallback) → `costSource: 'pricing'`
3. else 0 → `costSource: 'none'`

`summarize().totalCost` from the parser is overridden by the recomputed value so subscription providers get nonzero estimates.

**Aggregation invariant:** `buildAll()` builds `daily` / `modelTotals` per project in the same pass it builds session detail. `/api/projects/:encoded/sessions` reads these pre-aggregated maps — never re-walk JSONL inside per-project handlers (was N+1; latency dropped from seconds → ~40ms). `stripInternal()` removes `daily` / `modelTotals` before they leak to `/api/projects` and `/api/overview` responses.

**pi-specific encoding:** project dirs are encoded `--C--Users-foo-bar--` ↔ `C:\Users\foo\bar`. `decodeProjectDir()` in the parser; URL param `:encoded` is `encodeURIComponent(projectDir)`.

**Model-ID normalization:** pi uses dotted minor (`claude-sonnet-4.6`), LiteLLM uses dashed. `pi-pricing.js` `resolveKey()` tries exact → `provider/modelId` → pi-id mapping table → provider-hint strip (`dial`/`exa`/`github-copilot`/`auto` are billing routes, not model namespaces) → fuzzy substring.

**SPA:** vanilla JS, no build step. Hash routes `#/`, `#/projects`, `#/projects/:encoded`, `#/sessions/:id`. Regions in `public/app.js`: STATE, UTILS, URL_STATE, FETCH, RENDER_*, CHARTS, THEME, ROUTER, KEYBOARD, PI_INTEGRATION (`/pi-config`), INIT. Storage key prefix `pi-cost:`. Cost-source badges (`jsonl`/`pricing`) render via `srcBadge()`.

**Port 3461** (3460 is sibling project `pi-kanban`, do not collide).

**Extension (`extensions/cost.ts`):** TypeScript, ES2024 / NodeNext, `noEmit` (loaded by pi runtime directly). Lifecycle: `spawn(node, [serverPath], { detached, windowsHide })` + `probePort` polling; orphan cleanup via `netstat -ano` (win32) / `lsof` (posix) + `taskkill` / `SIGKILL`. Read-only — no kanban-style hooks.

## Conventions

- No SSE / chokidar — polling + `POST /api/refresh` only.
- Parser is **vendored** from `pi-kanban/lib/pi-parsers.js`, slimmed to cost-relevant fields. Do not re-introduce subagent enrichment / git-branch / image extraction / plan-watching here.
- `summarize()` mirrors pi-kanban's shape; keep field names (`totalInput`, `totalOutput`, `totalCacheRead`, `totalCacheWrite`) aligned so future sync is mechanical.
- **Theming:** 4 builtin themes in `themes/` — `classic-light` / `classic-dark` (orange `#e86f33`, pi-cost's original palette) and `pi-light` / `pi-dark` (pi.dev blue `#2f5f8a` / `#6a9fcc`). Each is JSON with 14 required color tokens (`bgDeep`…`error`). Server loads builtins + user themes from `~/.pi/agent/cost/themes/` and exposes `/api/themes` → `{ light, dark, config }`. Client `applyTheme()` writes 14 base vars + 9 derived rgba (`--accent-dim`/`-glow`/`-faint`/`-soft`/`-tag`, `--chart-fill`, `--success-dim`, `--warning-dim`, `--error-dim`) on `:root`. Selection precedence: env (`COST_LIGHT_THEME` / `COST_DARK_THEME` / `COST_THEME_DIR`) > `~/.pi/agent/cost/settings.json` `{ themes: { light, dark, dir } }` > defaults (`pi-light` / `pi-dark`). Extension (`extensions/cost.ts`) wires settings→env when spawning. Mode toggle: `body.light` / `body.dark-forced` over a `prefers-color-scheme` baseline; `localStorage.theme` persists explicit choice. See [docs/theming.md](./docs/theming.md).
