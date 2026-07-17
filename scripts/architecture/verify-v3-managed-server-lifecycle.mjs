#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT || process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const requireCount = (source, needle, expected, label) => {
  const actual = source.split(needle).length - 1;
  if (actual !== expected) throw new Error(`${label}: expected ${expected} occurrences of ${needle}, found ${actual}`);
};

const lifecycle = read('v3/crates/routecodex-v3-lifecycle/src/lib.rs');
const cli = read('v3/crates/routecodex-v3-cli/src/main.rs');
const server = read('v3/crates/routecodex-v3-server/src/lib.rs');
const configStore = read('v3/crates/routecodex-v3-config/src/store.rs');
const configLib = read('v3/crates/routecodex-v3-config/src/lib.rs');
const configTests = read('v3/crates/routecodex-v3-config/tests/config_v3_contract.rs');
const cliFoundationTests = read('v3/crates/routecodex-v3-cli/tests/foundation_cli.rs');
const cliManagedTests = read('v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs');
const workspace = read('v3/Cargo.toml');
const packageJson = read('package.json');
const resourceMap = read('docs/architecture/v3-resource-operation-map.yml');
const functionMap = read('docs/architecture/v3-function-map.yml');
const mainline = read('docs/architecture/v3-mainline-call-map.yml');
const verification = read('docs/architecture/v3-verification-map.yml');
const manifest = read('docs/architecture/manifests/v3.managed_server_lifecycle.mainline.yml');
const testDesign = read('docs/goals/v3-managed-server-lifecycle-test-design.md');

for (const symbol of [
  'V3ManagedInstanceDeclaration', 'V3ManagedPidCache', 'V3ManagedControlRecord',
  'pub struct V3ManagedLifecycle', 'pub async fn start', 'pub async fn status', 'pub async fn restart',
  'pub async fn stop', 'pub async fn start_foreground', 'pub async fn run_managed_child',
  'pub fn with_snapshots_enabled', 'pub fn with_console_enabled', 'acquire_operation_lock',
  'release_listener_set_for_start', 'signal_explicit_listener_pids', 'explicit_listener_pids',
  'spawn_v3_server_aggregate', 'handle.shutdown().await', 'serde(deny_unknown_fields)',
  'non_terminal_runtime_state_is_never_reaped_after_control_probe_failure',
  'stale_running_state_allows_release_snapshot_executable_rollover_when_control_is_gone',
  'fn owned_unreachable_runtime_state_is_reapable(',
  'fn listener_address_is_available(',
  'foreign_control_record_is_never_reaped_from_terminal_state',
  'fn same_instance_declaration_except_executable_path(',
  'fn terminal_state_allows_reaping_stale_release_executable_path_for_same_config_identity()',
  'fn stopped_instance_state_allows_release_snapshot_executable_rollover()',
  'fn running_instance_state_rejects_release_snapshot_executable_rollover()',
  'refusing to reap control record for a different instance',
  'refusing to reap non-canonical managed control socket path',
]) requireText(lifecycle, symbol, 'lifecycle source');
if ((lifecycle.match(/#\[serde\(deny_unknown_fields\)\]/g) || []).length < 7)
  throw new Error('lifecycle state/control schemas must all deny unknown fields');
requireText(lifecycle, 'load_snapshot_with_source_identity', 'lifecycle source');
requireText(lifecycle, 'release_listener_set_for_start(&instance_dir, &declaration).await?;', 'lifecycle start takeover call');
requireCount(lifecycle, 'release_listener_set_for_start(&instance_dir, &declaration).await?;', 2, 'lifecycle start takeover calls');
requireText(configStore, 'pub struct V3ConfigLoadedSnapshot', 'config store source identity owner');
requireText(configStore, 'source_sha256', 'config store source identity owner');
requireText(configStore, 'Sha256::digest(source.raw_toml.as_bytes())', 'config store source identity owner');
requireText(configLib, 'V3ConfigLoadedSnapshot', 'config lib export');
requireText(configTests, 'config_source_identity_is_stable_sensitive_and_secret_free', 'config source identity test');
requireText(cliManagedTests, 'managed_child_survives_start_cli_exit_and_is_controlled_by_new_cli_processes', 'managed CLI persistence test');
requireText(cliManagedTests, 'top_level_start_status_restart_stop_match_legacy_cli_shape', 'managed CLI top-level lifecycle compatibility test');
requireText(cliManagedTests, 'top_level_lifecycle_without_config_uses_home_config_v3_toml', 'managed CLI default config test');
requireText(cliManagedTests, 'top_level_start_snap_forces_debug_snapshots', 'managed CLI snap override test');
requireText(cliManagedTests, 'start_force_kills_explicit_listener_pid_after_graceful_timeout', 'managed CLI explicit PID takeover test');
requireText(cliManagedTests, 'config log_console=false', 'managed CLI foreground console test');
requireText(cliManagedTests, '[RouteCodexV3] Server started on ', 'managed CLI human startup console assertion');
requireCount(cliManagedTests, '▶ [/v1/responses]', 2, 'managed CLI request monitor assertion');
requireCount(cliManagedTests, '\\u{1b}[', 3, 'managed CLI request/error color assertion');
requireText(cliManagedTests, 'rawInputItems=1', 'managed CLI request monitor raw input assertion');
requireText(cliManagedTests, 'preparedInputItems=1', 'managed CLI request monitor prepared input assertion');
requireText(cliManagedTests, 'vec![(1, 1), (2, 2)]', 'managed CLI total/daily request id assertion');
requireText(cliManagedTests, 'send_path_not_found_request', 'managed CLI unknown path foreground error assertion');
requireText(cliManagedTests, '/_routecodex/diagnostics/virtual-router/status', 'managed CLI VR diagnostics status assertion');
requireText(cliManagedTests, 'vr_status["virtualRouter"]["routes"]["default"]["pools"][0]["poolId"]', 'managed CLI VR diagnostics pool assertion');
requireText(cliManagedTests, 'openai-chat-router-unknown-', 'managed CLI unknown path production request id assertion');
requireText(cliManagedTests, '!start_stderr.contains("❌ [unknown]")', 'managed CLI unknown path endpoint assertion');
requireCount(cliManagedTests, '!start_stderr.contains("request pre-request failed")', 2, 'managed CLI no pre-request assertion');
requireText(cliManagedTests, 'assert_ne!(\n        first_color, second_color', 'managed CLI different session color assertion');
requireText(cliManagedTests, '🎯 [/v1/responses]', 'managed CLI route/provider hit assertion');
requireText(cliManagedTests, '✅ [/v1/responses]', 'managed CLI completion monitor assertion');
requireText(cliManagedTests, '[usage]', 'managed CLI usage monitor assertion');
requireText(cliManagedTests, 'error=V3E', 'managed CLI compact error number assertion');
requireText(cliManagedTests, '!start_stderr.contains("errorChain=")', 'managed CLI no foreground error chain assertion');
requireText(cliManagedTests, '\\"node_id\\":\\"V3ServerStartup01ListenerSetPreflight\\"', 'managed CLI no raw debug JSON assertion');
requireText(cliFoundationTests, 'top_level_start_help_exposes_snap_and_optional_config', 'CLI top-level start help test');
requireText(cliManagedTests, 'fn stopped_instance_restarts_from_next_release_snapshot_executable()', 'managed CLI release rollover test');
requireText(cliManagedTests, 'fn copy_release_binary(', 'managed CLI release rollover helper');
requireText(cliManagedTests, 'scan_instance_files_for_secret', 'managed CLI secret scan');

for (const command of ['Start', 'Status', 'Restart', 'Stop', 'RunManagedChild'])
  requireText(cli, command, 'CLI managed command');
requireText(cli, '#[command(hide = true)]\n    Server', 'CLI compatible server namespace is hidden from user-facing help');
requireText(cli, 'Command::Start { config, snap }', 'CLI top-level foreground start dispatch');
requireText(cli, '.with_snapshots_enabled(snap)', 'CLI snap override dispatch');
requireText(cli, '.with_console_enabled(true)', 'CLI foreground console force');
requireText(cli, 'V3ManagedLifecycle::new', 'CLI thin lifecycle call');
requireText(workspace, 'crates/routecodex-v3-lifecycle', 'workspace member');
requireText(server, 'V3ServerStartup01ListenerSetPreflight', 'Server startup console event');
requireText(server, 'V3Server03HttpRequestRaw', 'Server common request console event');
requireText(server, '"V3ServerStartup01ListenerSetPreflight",\n                "listening"', 'Server startup console event recording');
requireText(server, '"V3Server03HttpRequestRaw",\n        "received"', 'Server common request console event recording');
requireText(server, 'emit_v3_startup_console_line', 'Server human startup console line');
requireText(server, 'colorize_v3_request_console_line', 'Server color request console line');
requireText(server, 'resolve_v3_log_session_color_key', 'Server old request-log color key resolver');
requireText(server, 'next_v3_console_request_id', 'Server independent foreground request id resolver');
requireText(server, 'emit_v3_request_route_console_line', 'Server route/provider hit console line');
requireText(server, 'emit_v3_request_complete_console_line', 'Server completion console line');
requireText(server, 'emit_v3_usage_console_line', 'Server usage console line');
requireText(server, 'compact_v3_error_number', 'Server compact error number console line');
requireText(server, 'get(virtual_router_status)', 'Server VR diagnostics status route');
requireText(server, 'project_v3_virtual_router_status', 'Server delegates VR diagnostics projection');

for (const id of [
  'v3.lifecycle.instance_declaration', 'v3.lifecycle.pid_cache',
  'v3.lifecycle.control_channel', 'v3.lifecycle.operation_lock',
]) requireText(resourceMap, id, 'resource map');
requireText(resourceMap, 'v3.config.source_identity', 'resource map');
for (const source of [functionMap, verification])
  requireText(source, 'v3.managed_server_lifecycle', 'feature map');
requireText(functionMap, 'v3/crates/routecodex-v3-config/src/store.rs', 'function map');
requireText(verification, 'Config-owned source identity', 'verification map');
requireText(mainline, 'v3.server.managed_lifecycle', 'mainline map');
requireText(mainline, 'v3.config.source_identity', 'mainline map');
for (let index = 1; index <= 7; index += 1)
  requireText(manifest, `V3Lifecycle0${index}`, 'lifecycle manifest');
requireText(testDesign, 'External CLI black-box', 'test design');
requireText(testDesign, 'Live matrix', 'test design');
requireText(testDesign, 'release snapshot executable', 'test design');
requireText(testDesign, 'may republish the same service declaration', 'test design');
requireText(testDesign, 'Missing terminal proof', 'test design');
requireText(testDesign, 'SIGTERM-resistant process on a configured listener port', 'test design');
requireText(packageJson, 'config_source_identity_is_stable_sensitive_and_secret_free', 'package test script');

const forbidden = [
  /Command::new\s*\(\s*["'](?:kill|pkill|killall)["']\s*\)/,
  /\bpkill\b|\bkillall\b|xargs\s+kill|kill\s*\$\(/,
  /fallback/i,
  /\b(?:resolved_secret|api_key_literal)\s*:/i,
];
for (const pattern of forbidden) {
  if (pattern.test(lifecycle)) throw new Error(`lifecycle source contains forbidden pattern ${pattern}`);
}

console.log('V3 managed server lifecycle architecture gate passed');
