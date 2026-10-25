# Changelog

## 0.2.0

### Breaking changes

- The server listens on `127.0.0.1` only. To reach it from another machine, start it with `--host 0.0.0.0 --allowed-hosts=<hostname>`.

### Features

- **Date ranges.** Pick a range with the date picker or a brush on the charts. The cost-by-model charts show hourly or daily series.
- **Insights, sessions and agents.** New pages and APIs: `/api/insights`, `/api/sessions`, and `/api/agents`.
- **Command line.** `pi-cost overview|insights|projects|sessions|agents|session` prints the same numbers in the terminal, or as JSON with `--json`.
- **Color themes.** 18 theme families in a theme menu, in light and dark.
- **pi-kanban pane.** `GET /api/companion` and the embed theme handshake let the pi-kanban board show pi-cost in a pane, in the board's colors.
- Keyboard help, loading skeletons, and fonts served locally.
- Follows pi's directory settings: `PI_CODING_AGENT_DIR`, `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, and `sessionDir` in `settings.json`.
- Uses the cost that pi records for each message.

### Security

- The server refuses requests with a non-local `Host` header and cross-site requests that change data.
- A content security policy lets only local pages frame pi-cost.

### Other

- Express 5 and current dependencies.
- A `node:test` suite for the parsers and routes.
