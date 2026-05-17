# pi-cost user guide

A walkthrough of the dashboard and `/cost` commands. For theme authoring, see [Theming](./theming.md).

## Getting started

pi-cost ships as a [pi](https://pi.dev) extension and a standalone npm package. The fastest path is to install it into pi, then drive it with `/cost` slash commands.

### Install

```sh
pi install npm:pi-cost
```

This registers the `/cost` command inside pi. No further configuration is required — the dashboard reads pi's session logs from `~/.pi/agent/sessions/` directly.

### Start the dashboard

From inside any pi session:

```text
/cost start
```

The extension spawns the dashboard server in the background on port **5461** and reports back when it is ready.

### Open the dashboard

```text
/cost open
```

Opens `http://localhost:5461` in your default browser. The Overview view loads with aggregate spend across every project pi has touched.

That's it — the rest of this guide describes what you'll see and how to navigate it.

### Without pi

If you don't use pi (or just want to peek at the UI), run the server directly:

```sh
npx pi-cost           # http://localhost:5461
```

The dashboard will be empty unless `~/.pi/agent/sessions/` contains session JSONL.

## Slash commands

Run from inside pi (the extension registers `/cost`):

| Command          | What it does                                        |
| ---------------- | --------------------------------------------------- |
| `/cost start`    | Start the local server (port 5461) in the background |
| `/cost stop`     | Stop the running server                              |
| `/cost restart`  | Restart the server (picks up theme/config changes)   |
| `/cost status`   | Show whether the server is running                   |
| `/cost open`     | Open the dashboard in the default browser            |

## Layout

pi-cost has three views, navigated by hash route.

### Overview — `#/`

Aggregate spend across all projects with daily and per-model breakdowns. The landing view.

![Overview](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/overview.png)

### Project — `#/projects/:encoded`

Per-session list for one project, plus model totals for that project. `:encoded` is the URL-encoded project directory (pi encodes paths like `--C--Users-foo-bar--` ↔ `C:\Users\foo\bar`).

![Project](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/project.png)

### Session — `#/sessions/:id`

Per-message detail: model, tokens (input / output / cache read / cache write), and cost with a source badge.

![Session](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/session.png)

## Cost sources

Every message is tagged so you know where the number came from:

| Badge       | `costSource` | Meaning                                                     |
| ----------- | ------------ | ----------------------------------------------------------- |
| **actual**  | `jsonl`      | pi recorded a real price in the JSONL (`dial`, `exa`).      |
| **estimated** | `pricing`  | Computed from token counts × LiteLLM pricing (refreshed every 6 hours, offline fallback bundled). Used for subscription-billed providers like `github-copilot` and the `auto` router. |
| —           | `none`       | No usage data — typically a tool/system message.            |

The per-message fallback chain:

1. `usage.cost.total > 0` → **actual**
2. else `pi-pricing` lookup against the LiteLLM table → **estimated**
3. else `0` → **none**

Session and project totals sum across all three, so subscription providers always get a nonzero estimate. Badges render inline in the session view above — look for `jsonl` / `pricing` chips next to each row's cost.

## Themes

Press `t` (or the topbar toggle) to flip between the configured light and dark themes. Same session, two looks:

| Dark                                                | Light                                                          |
| --------------------------------------------------- | -------------------------------------------------------------- |
| ![Session dark](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/session.png) | ![Session light](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/session-light.png) |

Four built-in themes ship out of the box (`pi-light`, `pi-dark`, `classic-light`, `classic-dark`); drop your own JSON in `~/.pi/agent/cost/themes/`. See [Theming](./theming.md).

## Refreshing data

- The server caches `buildAll()` in memory for 30 seconds.
- Press `r` in the dashboard, or `POST /api/refresh`, to drop the cache and re-scan JSONL.
- No file watcher / SSE — refresh is explicit.

## Keyboard shortcuts

Press `?` in the dashboard for the full list.

| Key             | Action                       |
| --------------- | ---------------------------- |
| `1` / `2`       | Switch view                  |
| `j` / `k`       | Next / previous row          |
| `Enter`         | Open selected row            |
| `Esc` / `Backspace` | Back / close modal       |
| `r`             | Refresh data                 |
| `t`             | Toggle dark / light theme    |
| `?`             | Show help                    |

## Configuration

Settings live in `~/.pi/agent/cost/settings.json`:

```json
{
  "themes": { "light": "pi-light", "dark": "pi-dark" }
}
```

Environment variables (take precedence — useful for one-off runs):

| Variable           | Effect                                  |
| ------------------ | --------------------------------------- |
| `COST_LIGHT_THEME` | Theme ID used in light mode             |
| `COST_DARK_THEME`  | Theme ID used in dark mode              |
| `COST_THEME_DIR`   | Directory to load user themes from      |

The server listens on port **5461** (sibling project pi-kanban uses 3460 — they don't collide).
