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

- `↑`: enter frozen history mode and scroll older final transactions
- `↓`: scroll toward newer history without resuming follow mode
- `Esc`: jump to latest history and resume automatic follow
- `space`: pause/resume simulated requests
- `+` / `-`: change simulation speed
- `f`: cycle `all -> port=5520 -> provider=minimax -> route=router-relay -> error`
- `r`: jump to latest history and resume automatic follow
- `q`: quit

Layout contract:

- Historical completed transactions occupy the upper area and scroll with terminal height.
- Live requests stay in a fixed bottom panel.
- Resize redraws the whole frame and recalculates history rows.
- Every simulated request appears in LIVE when admitted; response status/bytes update on the same row.
- Only terminal transactions enter history; intermediate route/provider changes update that same live row.
- New terminal history does not move a frozen history viewport; `Esc` restores latest-follow mode.
