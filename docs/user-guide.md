# pi-cost user guide

A walkthrough of the dashboard and `/cost` commands. For installation, see the [README](https://github.com/NikiforovAll/pi-cost#getting-started). For theme authoring, see [Theming](./theming.md).

## Slash commands

Run from inside pi (the extension registers `/cost`):

| Command          | What it does                                        |
| ---------------- | --------------------------------------------------- |
| `/cost start`    | Start the local server (port 3461) in the background |
| `/cost stop`     | Stop the running server                              |
| `/cost restart`  | Restart the server (picks up theme/config changes)   |
| `/cost status`   | Show whether the server is running                   |
| `/cost open`     | Open the dashboard in the default browser            |

Standalone (no pi required):

```sh
npx pi-cost           # http://localhost:3461
```

## Layout

pi-cost has three views, navigated by hash route:

| View      | Route                       | Preview                                     |
| --------- | --------------------------- | ------------------------------------------- |
| Overview  | `#/`                        | ![Overview](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/overview.png) |
| Projects  | `#/projects`                |                                             |
| Project   | `#/projects/:encoded`       | ![Project](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/project.png)   |
| Session   | `#/sessions/:id`            | ![Session](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/session.png)   |

- **Overview** — aggregate spend across all projects with daily/model breakdowns.
- **Project** — per-session list for one project, plus model totals.
- **Session** — per-message detail: model, tokens (input / output / cache read / cache write), and cost with a source badge.

`:encoded` is the URL-encoded project directory (pi encodes paths like `--C--Users-foo-bar--` ↔ `C:\Users\foo\bar`).

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

Session and project totals sum across all three, so subscription providers always get a nonzero estimate.

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

The server listens on port **3461** (sibling project pi-kanban uses 3460 — they don't collide).
