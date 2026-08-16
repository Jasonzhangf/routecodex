# V3 Console TUI Simulator

Standalone terminal prototype. No RouteCodex runtime wiring, provider calls, config loading, or live server mutation.

Run from an interactive terminal:

```bash
node tui-simulator.mjs
```

Headless smoke:

```bash
node smoke.mjs
```

Controls:

- `↑` / `↓`: scroll historical final transactions
- `space`: pause/resume simulated requests
- `+` / `-`: change simulation speed
- `f`: cycle `all -> port=5520 -> provider=minimax -> route=router-relay -> error`
- `r`: reset history scroll
- `q`: quit

Layout contract:

- Historical completed transactions occupy the upper area and scroll with terminal height.
- Live requests stay in a fixed bottom panel.
- Resize redraws the whole frame and recalculates history rows.
- Only terminal transactions enter history; intermediate route/provider changes update live rows.
