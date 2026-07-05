# rustification-governance budget

## L1 Budget

- Max wall time: 10 minutes.
- Max map/docs reads: 14 files.
- Max source-summary searches: 8.
- Max shell commands: 14.
- Max action items emitted: 5.
- Max raw output per command: 18,000 tokens.
- Code edits: 0.
- Process lifecycle actions: 0.
- Server/provider IO migration actions: 0.

## L2 Budget

- Disabled by default.
- Max one owner-scoped diff.
- Max one `gate-matrix.md` row.
- Max three attempts on the same item.
- Required classification movement must be explicit:
  - `ts_semantic_debt -> rust_ssot`, or
  - `ts_semantic_debt -> native_shell_ok`, or
  - documented escalation when only `ts_io_shell_ok` is appropriate.
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
- Finding requires server IO or provider transport rustification without an
  approved phase.
