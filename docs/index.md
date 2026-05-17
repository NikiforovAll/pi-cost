---
layout: home

hero:
  name: "pi-cost"
  text: "Cost dashboard for the pi coding agent"
  tagline: Overview → project → session → message, with actual and estimated spend.
  image:
    src: https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/overview.png
    alt: pi-cost dashboard
  actions:
    - theme: brand
      text: User Guide
      link: /user-guide
    - theme: alt
      text: Theming
      link: /theming
    - theme: alt
      text: View on GitHub
      link: https://github.com/NikiforovAll/pi-cost

features:
  - title: Zero-config cost tracking
    details: Reads pi's session JSONL directly from ~/.pi/agent/sessions. No instrumentation, no daemon to configure.
  - title: Actual + estimated pricing
    details: dial/exa report real cost; github-copilot/auto fall back to LiteLLM pricing × token counts. Every row is tagged so you know which is which.
  - title: Drill-down navigation
    details: Overview → project → session → message. Hash routes are shareable, keyboard navigation is first-class.
  - title: Themed
    details: Four built-in themes (pi-light/dark, classic-light/dark) plus 14-token custom themes loaded from disk.
  - title: Pi-native
    details: Installs as a pi package (pi install npm:pi-cost). /cost start | stop | restart | status | open controls the server from inside pi.
  - title: Standalone too
    details: npx pi-cost runs the dashboard without pi. Same UI, same data — just point it at ~/.pi/agent/sessions.
---
