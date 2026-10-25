# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps (`express` 5, `open`, `chart.js`).
- `npm start` — run server at `http://localhost:5461` (random port when it is in use).
- `npm run dev` — same, auto-opens browser.
- `npm test` — `node --test` over `test/*.test.js`. Fixtures are synthetic (`test/helpers/fixtures.js`); never copy real `~/.pi/agent` data into tests.
- Server flags: `--port <n>` (exact; exits when in use), `--host <h>` (default 127.0.0.1), `--allowed-hosts <list>`, `--open` / `--no-open`, `--session-dir <dir>`.
- CLI: `node server.js <overview|insights|projects|sessions|agents|session|help> [flags]` — see `lib/cli.js`.
- As a pi extension: `pi --add ./extensions`, then `/cost start|stop|restart|status|open`.
- `PI_COST_OFFLINE=1` uses the bundled prices instead of fetching LiteLLM.

## Architecture

**Modules:** `server.js` (args, listen, `server.json`) → `lib/app.js` `createApp({net, themes})` (express routes) → `lib/costs.js` (data layer) → `lib/pi-parsers-cost.js` (paths, `pathKey`, `getCostDir`, listing, JSONL parse) + `lib/pi-pricing.js`. Also `lib/cost-dir.js` (`server.json` read/write, cost `settings.json`, `isAlive`), `lib/net-guard.js` (Host/Origin guard, CSP, dual-stack loopback listen), `lib/themes.js`, `lib/cli.js`, `lib/args.js`.

**Paths:** agent dir = `PI_CODING_AGENT_DIR`, else `<PI_DIR or ~/.pi>/agent`. Session roots (`resolveRoots`): a custom flat dir from `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > absolute `sessionDir` in `<agentDir>/settings.json`, then always the nested `<agentDir>/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`. In a flat dir the project comes from the header `cwd`. Every root goes through `longPath()` (`fs.realpathSync.native`) so 8.3 short names (`NIKIFO~1`) match; paths that pi records in JSONL (`parentSession`, subagent `sessionFile`) are compared through `pathKey()` (memoized; `longPath()` only for paths with `~`, lowercased on Windows).

**Data flow:** `loadSessions(cutoff)` builds one session model per file (cached by mtime + size + pricing fetch time): every billed row in time order — assistant turns, compactions that recorded `usage`, and pi-subagents runs from `subagent` toolResults. Endpoint results are cached 30 s (cap 50 keys). Nested subagent runs (`<projDir>/<parent basename>/<runId>/<attempt>/session.jsonl`) are not listed as sessions; their cost is the parent's subagent row, and `loadNestedIndex()` maps them to ids so a run opens as its own detail page.

**Cost model — critical:** pi messages carry `usage.cost.total` only for some providers (`dial`, `exa`, `codemie`); `github-copilot` / `auto` come back zero. Per row:
1. `usage.cost.total > 0` → `costSource: 'jsonl'` (actual)
2. else `pi-pricing.js` `estimate(provider, model, usage)` against LiteLLM pricing (6h refresh, offline fallback) → `costSource: 'pricing'`
3. else 0 → `costSource: 'none'`

A session's `totalCost` includes its subagent rows; `subagentCost` is a part of it, never added on top.

**Range model:** `range` is `'today'`, `'24h'`, N calendar days, `null` (all time) or a custom `{from, to}` of local dates (`from`/`to` query params win over `range`). `resolveWindow()` anchors one `now` per request. One-day windows bucket by hour, others by day; `costSeries.points[].byModel` feeds the stacked chart.

**API:** `/api/overview`, `/api/insights`, `/api/projects`, `/api/projects/:encoded/sessions`, `/api/sessions` (`?project=`), `/api/agents`, `/api/sessions/:id` (adds `inRange` / `today` slices), `/api/pricing`, `/api/themes`, `/api/companion`, `/pi-config`, `POST /api/refresh`. Bad windows/projects → 400, unknown session → 404.

**Model-ID normalization:** pi uses dotted minor (`claude-sonnet-4.6`), LiteLLM uses dashed. `pi-pricing.js` `resolveKey()` tries exact → `provider/modelId` → pi-id mapping table → provider-hint strip (`dial`/`exa`/`github-copilot`/`auto` are billing routes, not model namespaces) → fuzzy substring.

**SPA:** vanilla JS, no build step. Query-param routes: `/`, `?view=insights`, `?view=projects`, `?view=sessions&project=<encoded>`, `?session=<id>`. Regions in `public/app.js`: STATE, UTILS, URL_STATE, FETCH, RENDER_*, CHARTS, DATE_PICKER, RANGE_BRUSH, THEME, EMBED, ROUTER, KEYBOARD, AUTO_REFRESH, PI_INTEGRATION, INIT. Storage key prefix `pi-cost:`. Interpolated HTML goes through `esc()` / `escAttrJs()`; `test/escaping.test.js` holds the count at its baseline. Fonts (`public/fonts/`) and Chart.js (`/vendor/chart.umd.min.js`, served from `node_modules`) are local so the page works offline inside pi-kanban.

**Embed contract (pi-kanban):** the board spawns `pi-cost --port <n|0> --host 127.0.0.1 --no-open` with `PI_CODING_AGENT_DIR`, waits for `pi-cost listening on http://localhost:<port>`, and probes `GET /api/companion` → `{name: 'pi-cost', version, session: '/?session={id}'}`. It frames the page with `&embed=1`; the page posts `pi-companion:ready` to the parent and accepts `pi-companion:theme {mode, colors}` (14 keys) only from `window.parent`. In embed mode the theme button is hidden and the theme is not stored. CSP `frame-ancestors 'self' http://localhost:* http://127.0.0.1:*`. Do not change this without telling pi-kanban.

**Port 5461** (3460 is sibling project `pi-kanban`, do not collide). The server writes `<agentDir>/cost/server.json` `{pid, port, sessionRoots}`; the CLI and the extension find the server through it.

**Extension (`extensions/cost.ts`):** TypeScript, ES2024 / NodeNext, `noEmit` (loaded by pi runtime directly). Reads the agent dir through `lib/pi-parsers-cost.js` and `server.json` through `lib/cost-dir.js`, spawns `server.js --no-open` detached with `PI_CODING_AGENT_DIR` and `PORT=5461` (the server reads theme settings itself), and waits for its `server.json`. Stop kills the pid in `server.json`. Read-only — no kanban-style hooks.

## Conventions

- No SSE / chokidar — polling + `POST /api/refresh` only.
- Parser is **vendored** from `pi-kanban/lib/pi-parsers.js`, slimmed to cost-relevant fields. Do not re-introduce subagent enrichment / git-branch / image extraction / plan-watching here.
- `summarize()` mirrors pi-kanban's shape; keep field names (`totalInput`, `totalOutput`, `totalCacheRead`, `totalCacheWrite`) aligned so future sync is mechanical.
- **Theming:** 36 builtin themes in `themes/`, 18 `<id>-light` / `<id>-dark` families: `pi` (pi.dev blue `#2f5f8a` / `#6a9fcc`, default), `classic` (orange `#e86f33`, pi-cost's original palette) and 16 palettes converted from claude-code-cost. Each is JSON with 14 required color tokens (`bgDeep`…`error`). Server loads builtins + user themes from `<agentDir>/cost/themes/` and exposes `/api/themes` → `{ light, dark, families, config }`. The palette menu (standalone only) picks a family and stores it in `localStorage["pi-cost:color-theme"]`; in embed mode `body.embed` hides the theme controls. Client `applyTheme()` writes 14 base vars + derived rgba vars on `:root`. Selection precedence: env (`COST_LIGHT_THEME` / `COST_DARK_THEME` / `COST_THEME_DIR`) > `<agentDir>/cost/settings.json` `{ themes: { light, dark, dir } }` > defaults (`pi-light` / `pi-dark`). Mode toggle: `body.light` / `body.dark-forced` over a `prefers-color-scheme` baseline; `localStorage.theme` persists explicit choice (not in embed mode). See [docs/theming.md](./docs/theming.md).
- `_plans/port-from-claude-code-cost.md` lists what was ported from claude-code-cost and what was skipped, with reasons.
