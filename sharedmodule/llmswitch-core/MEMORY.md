# llmswitch-core Memory

Tags: clock, daemon, tmux, lifecycle, architecture

## Clock architecture (2026-03-09)
- `clock` is tmux-only. Missing tmux scope is a hard failure for CRUD actions.
- Request-side clock behavior is reduced to time-tag injection only.
- Request-side reminder reservation / commit / due-message injection / hold followup paths are removed.
- Public clock actions are `now`, `schedule.set`, `schedule.list`, `schedule.update`, `schedule.delete`, `schedule.clear`.
- Old actions are compatibility aliases only.
- Clock scheduling is normalized to 5-minute granularity and recurring intervals must be multiples of 5 minutes.
- Clock scheduler lifecycle must stay singleton-safe inside the shared server runtime; no extra daemon and no orphan timers.
- Clock daemon dispatch is now runtime-hook based: core owns task selection, injection text, and trigger marking; host only supplies tmux-alive probing plus actual inject transport.
- If a tmux session is known missing, core prunes the corresponding clock task file on list/dispatch paths instead of keeping stale tasks around.
