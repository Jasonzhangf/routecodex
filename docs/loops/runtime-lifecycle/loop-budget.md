# runtime-lifecycle-release-watch budget

## L1 Budget

- Max wall time: 10 minutes.
- Max map/docs reads: 12 files.
- Max runtime log reads: 3 files.
- Max shell commands: 12.
- Max action items emitted: 5.
- Max raw output per command: 18,000 tokens.
- Code edits: 0.
- Process lifecycle actions: 0.

## L2 Budget

- Disabled by default.
- Max one owner-scoped diff.
- Max one `gate-matrix.md` row.
- Max three attempts on the same item.
- Required whitebox, blackbox, quality, and checker gates must be listed before
  editing.
- Checker required before approval.

## L3 Budget

- Disabled.
- Requires explicit approval plus proven L1/L2 run history.

## Stop Conditions

- Kill switch active.
- Budget exceeded.
- No actionable item found.
- Required owner/gate cannot be located.
- Verification cannot be run within budget.
- Collision with unrelated dirty worktree changes.
