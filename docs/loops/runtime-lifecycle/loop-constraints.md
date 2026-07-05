# runtime-lifecycle-release-watch constraints

## Allowed In L1

- Read project docs, architecture maps, package scripts, memory summaries, and
  runtime lifecycle logs.
- Append summaries to `STATE.md` and `loop-run-log.md`.
- Report findings with owner/gate references.
- Recommend L2 escalation when evidence is concrete.

## Forbidden In L1

- Runtime code edits.
- Package, build, release, provider, auth, secret, or user config edits.
- Global install, uninstall, release install, managed restart, or live replay.
- Starting or stopping RouteCodex processes.
- `git checkout`, `git reset`, broad restore, broad delete, or broad cleanup.
- Broad process kill commands: `pkill`, `killall`, `kill $(...)`, `xargs kill`.
- Staging or committing changes.
- Fallback, silent success, disabled tests, weakened assertions, or report-only
  findings presented as closure.

## L2 Action Rules

- One item per run.
- One `watchlist_id` from `gate-matrix.md`.
- One owner path per fix.
- Maximum three attempts per item, then escalate.
- Required maps, whitebox gates, blackbox gates, and quality checks must be
  known before editing.
- Checker must verify scope, denylist, intent, tests, and evidence.
- No auto-merge.

## Escalate Immediately

- Kill switch active.
- Dirty worktree collision affects target files.
- Owner cannot be found in one or two map queries.
- Required verification is missing or cannot run.
- Required `gate-matrix.md` row is missing or ambiguous.
- Any action would touch auth, secrets, provider accounts, payment, production
  config, migration, or global install state.
- Same item failed three times.
