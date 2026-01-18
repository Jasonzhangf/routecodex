# CLI Command Inventory & Contracts

Source of truth: `src/cli.ts` (wiring) + command implementations in `src/cli/commands/*` and `src/commands/*`.

## Inventory (from `src/cli.ts`)

| Command | Where registered | Implementation | Side effects (non-exhaustive) | Exit behavior |
|---|---|---|---|---|
| `env` | `src/cli/register/basic-commands.ts` | `src/cli/commands/env.ts` | Reads config file (optional) | `ctx.exit(1)` on parse/config errors; otherwise returns |
| `clean` | `src/cli/register/basic-commands.ts` | `src/cli/commands/clean.ts` | Deletes captures/logs via `fs.rmSync(recursive)` | Returns on success; on failure uses spinner/logger (no direct `ctx.exit` in this file) |
| `examples` | `src/cli/register/basic-commands.ts` | `src/cli/commands/examples.ts` | Prints examples | Returns |
| `port` | `src/cli/register/basic-commands.ts` | `src/cli/commands/port.ts` | Reads port listeners; may kill PIDs (`--kill`) | `ctx.exit(2)` on invalid port; `ctx.exit(1)` on failures |
| `config` | `src/cli/register/status-config-commands.ts` | `src/cli/commands/config.ts` | Writes config file; reads existing config | Returns (no direct `ctx.exit` in this file) |
| `status` | `src/cli/register/status-config-commands.ts` | `src/cli/commands/status.ts` | Network `fetch` to server status endpoint | Returns (no direct `ctx.exit` in this file) |
| `start` | `src/cli/register/start-command.ts` | `src/cli/commands/start.ts` | Reads config; may write temp config + pid file; may `fetch` shutdown; may kill PIDs; spawns server (`node dist/index.js`) | Uses `ctx.exit(...)` for success/error paths |
| `stop` | `src/cli/register/stop-command.ts` | `src/cli/commands/stop.ts` | Reads config (release); kill PIDs; optional token-daemon stop | `ctx.exit(1)` on config/stop failures; otherwise returns |
| `restart` | `src/cli/register/restart-command.ts` | `src/cli/commands/restart.ts` | Reads config; kill PIDs; may `fetch` shutdown; spawns server; writes pid file | Uses `ctx.exit(...)` for success/error paths |
| `code` | `src/cli/register/code-command.ts` | `src/cli/commands/code.ts` | Reads config for `apikey`; may `fetch /ready`; may spawn server; spawns `claude` | Uses `ctx.exit(...)` for success/error paths |
| `provider-update` *(optional)* | `src/cli.ts` dynamic import | `src/commands/provider-update.ts` | Reads/writes provider config and lists; may call RouteCodex HTTP endpoint for probing | Uses `process.exit(1)` in multiple branches |
| `camoufox-fp` *(optional)* | `src/cli.ts` dynamic import | `src/commands/camoufox-fp.ts` | Reads fingerprint JSON on disk | Sets `process.exitCode` on errors |
| `camoufox-backfill` *(optional)* | `src/cli.ts` dynamic import | `src/commands/camoufox-backfill.ts` | Backfills fingerprints (disk IO) | Uses `process.exitCode` on errors (by pattern) |
| `token-daemon` *(optional)* | `src/cli.ts` dynamic import | `src/commands/token-daemon.ts` | Spawns background daemon; reads/writes snapshots | Uses `process.exit(...)` / `process.exitCode` in command handlers |
| `quota-status` *(optional)* | `src/cli.ts` dynamic import | `src/commands/quota-status.ts` | Reads quota snapshot file | Returns; throws on missing file |
| `quota-daemon` *(optional)* | `src/cli.ts` dynamic import | `src/commands/quota-daemon.ts` | Reads replay NDJSON; writes `provider-quota.json` unless `--dry-run` | Returns; on failure throws/sets exit |
| `oauth` *(optional)* | `src/cli.ts` dynamic import | `src/commands/oauth.ts` | Triggers OAuth flows (Camoufox/browser automation) | Returns; may set exit codes on failures (subcommands) |
| `validate` *(optional)* | `src/cli.ts` dynamic import | `src/commands/validate.ts` | `fetch` health + API; may spawn `rcc start`; reads payload file | Calls `process.exit(1)` on failures |

## Contracts (inputs/outputs) — extracted from `.option(...)`

### `env` (`src/cli/commands/env.ts`)
- Inputs: `--port`, `--host`, `--config`, `--json`; reads config file if present.
- Output: prints shell exports (default) or JSON (`--json`).
- Exit: `1` on invalid/missing config-derived port.

### `clean` (`src/cli/commands/clean.ts`)
- Inputs: `--yes`, `--what <targets>` (default `all`).
- Output: spinner/log messages about deleted targets.
- Exit: no explicit `ctx.exit` in this file (errors are handled inside action).

### `port` (`src/cli/commands/port.ts`)
- Inputs: `--port <port>` (default `5555`), `--kill`.
- Output: diagnostics; when `--kill`, attempts to kill listeners.
- Exit: `2` on invalid port; `1` on kill failure or unexpected errors.

### `config` (`src/cli/commands/config.ts`)
- Inputs: `--config <config>`, `--template <template>`, `--force`.
- Output: writes/prints config info via logger/spinner.
- Exit: no explicit `ctx.exit` in this file.

### `status` (`src/cli/commands/status.ts`)
- Inputs: `--json`.
- Output: human-readable status or JSON.
- Exit: no explicit `ctx.exit` in this file.

### `start` (`src/cli/commands/start.ts`)
- Inputs: `--config`, `--port`, `--quota-routing on|off`, `--log-level`, `--codex/--claude`, `--ua`, `--snap/--snap-off`, `--verbose-errors/--quiet-errors`, `--restart`, `--exclusive`.
- Output: spinner/log lines; server process inherits stdio.
- Exit: `0` on normal termination; `1` on validation/start/shutdown errors.

### `stop` (`src/cli/commands/stop.ts`)
- Inputs: none; release mode reads config file for port; dev mode uses default/env port.
- Output: spinner/log lines about stop result.
- Exit: `1` on configuration/stop errors.

### `restart` (`src/cli/commands/restart.ts`)
- Inputs: `--config`, `--log-level`, `--codex/--claude`.
- Output: spinner/log lines; server process inherits stdio.
- Exit: `0` on normal termination; `1` on validation/restart errors.

### `code` (`src/cli/commands/code.ts`)
- Inputs: `--port`, `--host` (default `0.0.0.0`), `--url`, `--config`, `--apikey`, `--claude-path`, `--cwd`, `--model`, `--profile`, `--ensure-server`.
- Output: launches Claude Code (subprocess inherits stdio).
- Exit: `0` when Claude exits cleanly; `1` on connection/start failures.

### Optional command groups (`src/commands/*`)
These are wired via `program.addCommand(...)` and still use `process.exit(...)`/`process.exitCode` in places. They are not yet migrated into the `ctx.exit`/testable registration pattern.
