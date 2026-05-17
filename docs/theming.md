# Theming

pi-cost ships with four built-in themes and supports user-defined themes. Themes are simple JSON files declaring 14 design-token colors; derived `*-dim` / `*-glow` / `*-faint` / `*-soft` / `*-tag` / `chart-fill` variants are computed automatically at runtime.

## Built-in themes

| ID              | Mode  | Accent    | Description                                       |
| --------------- | ----- | --------- | ------------------------------------------------- |
| `pi-light`      | light | `#2f5f8a` | pi.dev blue palette, light (default)              |
| `pi-dark`       | dark  | `#6a9fcc` | pi.dev blue palette, dark (default)               |
| `classic-light` | light | `#e86f33` | pi-cost's original orange palette, light          |
| `classic-dark`  | dark  | `#e86f33` | pi-cost's original orange palette, dark           |

The toggle button in the topbar switches between the configured light and dark themes. When no preference is saved, the browser's `prefers-color-scheme` decides; an explicit choice persists in `localStorage.theme`.

Same session view, two themes:

| Dark                                                | Light                                                          |
| --------------------------------------------------- | -------------------------------------------------------------- |
| ![Session dark](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/session.png) | ![Session light](https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/session-light.png) |

## Configuring themes

Configure themes via `~/.pi/agent/cost/settings.json`:

```json
{
  "themes": {
    "light": "pi-light",
    "dark": "pi-dark"
  }
}
```

The extension (`extensions/cost.ts`) reads this file when starting the server and forwards the values as environment variables.

## Environment variable overrides

Take precedence over `settings.json`. Useful for one-off runs.

| Variable            | Effect                      |
| ------------------- | --------------------------- |
| `COST_LIGHT_THEME`  | Theme ID used in light mode |
| `COST_DARK_THEME`   | Theme ID used in dark mode  |
| `COST_THEME_DIR`    | User theme directory        |

## Authoring a custom theme

Drop a JSON file in `~/.pi/agent/cost/themes/` (or your configured `COST_THEME_DIR`):

```json
{
  "name": "my-theme",
  "displayName": "My Theme",
  "mode": "dark",
  "colors": {
    "bgDeep": "#0d1116",
    "bgSurface": "#161d27",
    "bgElevated": "#212730",
    "bgHover": "#252f3d",
    "border": "#495059",
    "textPrimary": "#ebe7e4",
    "textSecondary": "#d5d8db",
    "textTertiary": "#9fa4ab",
    "textMuted": "#757d89",
    "accent": "#6a9fcc",
    "accentText": "#8fb6d8",
    "success": "#4ade80",
    "warning": "#fbbf24",
    "error": "#ef4444"
  }
}
```

Required fields: `name`, `mode` (`"light"` or `"dark"`), and all 14 `colors.*` keys. Themes failing validation are skipped with a server-side warning.

Reference it from `~/.pi/agent/cost/settings.json`:

```json
{ "themes": { "dark": "my-theme" } }
```

Restart the server (`/cost restart`) to pick up new themes.

## Derived tokens

`applyTheme()` (client-side) computes these rgba variants from the base palette so theme authors only need the 14 solid colors:

| Variable          | Source     | Light alpha | Dark alpha |
| ----------------- | ---------- | ----------- | ---------- |
| `--accent-dim`    | `accent`   | 0.18        | 0.22       |
| `--accent-glow`   | `accent`   | 0.50        | 0.55       |
| `--accent-faint`  | `accent`   | 0.06        | 0.05       |
| `--accent-soft`   | `accent`   | 0.12        | 0.12       |
| `--accent-tag`    | `accent`   | 0.15        | 0.15       |
| `--chart-fill`    | `accent`   | 0.50        | 0.60       |
| `--success-dim`   | `success`  | 0.15        | 0.18       |
| `--warning-dim`   | `warning`  | 0.15        | 0.18       |
| `--error-dim`     | `error`    | 0.15        | 0.18       |
