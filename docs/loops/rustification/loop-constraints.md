# rustification-governance constraints

## Allowed In L1

- Read project docs, architecture maps, memory summaries, source summaries, and
  existing verification scripts.
- Append summaries to `STATE.md` and `loop-run-log.md`.
- Report findings with owner/gate references.
- Classify paths as `rust_ssot`, `native_shell_ok`, `ts_io_shell_ok`, or
  `ts_semantic_debt`.
- Recommend L2 escalation when evidence is concrete.

## Forbidden In L1

- Runtime code edits.
- Package, build, release, provider, auth, secret, user config, or production
  config edits.
- Server IO or provider transport migration.
- Global install, uninstall, release install, managed restart, live replay, or
  production process lifecycle actions.
- Starting or stopping RouteCodex processes.
- `git checkout`, `git reset`, broad restore, broad delete, or broad cleanup.
- Broad process kill commands: `pkill`, `killall`, `kill $(...)`, `xargs kill`.
- Staging or committing changes.
- Fallback, silent success, disabled tests, weakened assertions, TS semantic
  duplicates, or report-only findings presented as closure.

## L2 Action Rules

- One item per run.
- One `watchlist_id` from `gate-matrix.md`.
- One owner path per fix.
- Maximum three attempts per item, then escalate.
- Required maps, adjacent mainline edges, whitebox gates, blackbox gates, and
  quality checks must be known before editing.
- Checker must verify scope, denylist, intent, tests, evidence, and
  classification movement.
- No auto-merge.

## Migration Boundaries

- Hub Pipeline and Virtual Router semantic fixes default to Rust/native truth.
- TypeScript may remain only as `native_shell_ok` or `ts_io_shell_ok`.
- Server IO Rustification is not implied by Hub/VR rustification and requires a
  separately approved phase.
- Provider transport Rustification is not implied by Hub/VR rustification and
  requires a separately approved phase.
- Removing TypeScript is not progress unless the replacement owner, gates, and
  replay evidence prove equivalent or stricter behavior.

## Escalate Immediately

- Kill switch active.
- Dirty worktree collision affects target files.
- Owner cannot be found in one or two map queries.
- Required verification is missing or cannot run.
- Required `gate-matrix.md` row is missing or ambiguous.
- Any action would touch auth, secrets, provider accounts, payment, production
  config, migration, global install state, server IO migration, or provider
  transport migration without explicit approval.
- Same item failed three times.
