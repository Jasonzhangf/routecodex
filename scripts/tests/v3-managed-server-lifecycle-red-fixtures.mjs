#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const files = [
  'v3/crates/routecodex-v3-lifecycle/src/lib.rs',
  'v3/crates/routecodex-v3-cli/src/main.rs',
  'v3/crates/routecodex-v3-cli/tests/foundation_cli.rs',
  'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-config/src/store.rs',
  'v3/crates/routecodex-v3-config/src/lib.rs',
  'v3/crates/routecodex-v3-config/tests/config_v3_contract.rs',
  'v3/Cargo.toml',
  'package.json',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.managed_server_lifecycle.mainline.yml',
  'docs/goals/v3-managed-server-lifecycle-test-design.md',
];

const mutations = [
  ['remove lifecycle owner', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'pub struct V3ManagedLifecycle', 'pub struct RemovedLifecycle'],
  ['inject broad kill', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'fn epoch_ms()', 'fn forbidden() { let _ = Command::new("pkill"); }\nfn epoch_ms()'],
  ['remove strict schema', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', '#[serde(deny_unknown_fields)]', '#[serde(default)]'],
  ['remove non-terminal reaping guard', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'non_terminal_runtime_state_is_never_reaped_after_control_probe_failure', 'removed_non_terminal_runtime_state_guard'],
  ['remove stale running release rollover positive guard', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'stale_running_state_allows_release_snapshot_executable_rollover_when_control_is_gone', 'removed_stale_running_release_rollover_guard'],
  ['remove stale running port availability guard', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'fn listener_address_is_available(', 'fn removed_listener_address_is_available('],
  ['remove foreign control reaping guard', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'foreign_control_record_is_never_reaped_from_terminal_state', 'removed_foreign_control_reaping_guard'],
  ['remove release executable rollover helper', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'fn same_instance_declaration_except_executable_path(', 'fn removed_same_instance_declaration_except_executable_path('],
  ['remove terminal release rollover positive test', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'fn stopped_instance_state_allows_release_snapshot_executable_rollover()', 'fn removed_stopped_release_snapshot_rollover_test()'],
  ['remove active release rollover negative test', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'fn running_instance_state_rejects_release_snapshot_executable_rollover()', 'fn removed_running_release_snapshot_rollover_test()'],
  ['remove CLI release rollover blackbox', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'fn stopped_instance_restarts_from_next_release_snapshot_executable()', 'fn removed_stopped_instance_restarts_from_next_release_snapshot_executable()'],
  ['remove top-level lifecycle blackbox', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'fn top_level_start_status_restart_stop_match_legacy_cli_shape()', 'fn removed_lifecycle_compat_shape()'],
  ['remove old request monitor assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '▶ [/v1/responses]', 'V3Server03HttpRequestRaw'],
  ['remove human startup assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '[RouteCodexV3] Server started on ', 'V3ServerStartup01ListenerSetPreflight'],
  ['remove VR diagnostics status blackbox', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '/_routecodex/diagnostics/virtual-router/status', '/_routecodex/diagnostics/removed-status'],
  ['remove VR diagnostics pool assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'vr_status["virtualRouter"]["routes"]["default"]["pools"][0]["poolId"]', 'vr_status["virtualRouter"]["routes"]["default"]["pools"][0]["removed"]'],
  ['remove request color assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '\\u{1b}[', 'no-color-required'],
  ['remove total/daily request id assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'vec![(1, 1), (2, 2)]', 'vec![(2, 5), (4, 9)]'],
  ['remove unknown path request id assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'openai-chat-router-unknown-', 'unknown-path-request-id-removed'],
  ['remove unknown path endpoint denial', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '!start_stderr.contains("❌ [unknown]")', 'start_stderr.contains("❌ [unknown]")'],
  ['remove no pre-request denial', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '!start_stderr.contains("request pre-request failed")', 'start_stderr.contains("request pre-request failed")'],
  ['remove different session color assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'assert_ne!(\n        first_color, second_color', 'assert_eq!(\n        first_color, second_color'],
  ['remove route/provider monitor assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '🎯 [/v1/responses]', 'route-provider-monitor-removed'],
  ['remove completion monitor assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '✅ [/v1/responses]', 'completion-monitor-removed'],
  ['remove usage monitor assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '[usage]', 'usage-monitor-removed'],
  ['remove compact error number assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'error=V3E', 'errorNode=V3Error06ClientProjected'],
  ['remove compact error chain denial', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '!start_stderr.contains("errorChain=")', 'start_stderr.contains("errorChain=")'],
  ['remove no raw debug json assertion', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', '\\"node_id\\":\\"V3ServerStartup01ListenerSetPreflight\\"', 'debug-json-allowed'],
  ['remove no-config default blackbox', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'fn top_level_lifecycle_without_config_uses_home_config_v3_toml()', 'fn removed_default_config_blackbox()'],
  ['remove snap override blackbox', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'fn top_level_start_snap_forces_debug_snapshots()', 'fn removed_snap_override_blackbox()'],
  ['remove start help snap contract', 'v3/crates/routecodex-v3-cli/tests/foundation_cli.rs', 'fn top_level_start_help_exposes_snap_and_optional_config()', 'fn removed_top_level_start_help_contract()'],
  ['remove foreground start dispatch', 'v3/crates/routecodex-v3-cli/src/main.rs', 'Command::Start { config, snap } => {', 'Command::Start { config: _, snap: _ } => {'],
  ['remove startup console event', 'v3/crates/routecodex-v3-server/src/lib.rs', '"V3ServerStartup01ListenerSetPreflight",\n                "listening"', '"V3ServerStartupEventRemoved",\n                "listening"'],
  ['remove common request console event', 'v3/crates/routecodex-v3-server/src/lib.rs', '"V3Server03HttpRequestRaw",\n        "received"', '"V3ServerRequestEventRemoved",\n        "received"'],
  ['remove explicit PID takeover blackbox', 'v3/crates/routecodex-v3-cli/tests/managed_lifecycle.rs', 'fn start_force_kills_explicit_listener_pid_after_graceful_timeout()', 'fn removed_explicit_pid_takeover_blackbox()'],
  ['remove lifecycle takeover call', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'release_listener_set_for_start(&instance_dir, &declaration).await?;', 'let _ = (&instance_dir, &declaration);'],
  ['remove config source identity', 'v3/crates/routecodex-v3-config/src/store.rs', 'pub struct V3ConfigLoadedSnapshot', 'pub struct RemovedConfigLoadedSnapshot'],
  ['remove PID cache resource', 'docs/architecture/v3-resource-operation-map.yml', 'v3.lifecycle.pid_cache', 'v3.lifecycle.removed_pid_cache'],
  ['remove release rollover contract from test design', 'docs/goals/v3-managed-server-lifecycle-test-design.md', 'may republish the same service declaration', 'may use a different executable'],
  ['remove release rollover negative contract from test design', 'docs/goals/v3-managed-server-lifecycle-test-design.md', 'Missing terminal proof', 'Missing proof'],
  ['remove explicit PID takeover contract from test design', 'docs/goals/v3-managed-server-lifecycle-test-design.md', 'SIGTERM-resistant process on a configured listener port', 'ordinary listener process on a configured listener port'],
  ['remove live matrix', 'docs/goals/v3-managed-server-lifecycle-test-design.md', '## Live matrix', '## Removed matrix'],
];

for (const [name, target, before, after] of mutations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-life-red-'));
  for (const file of files) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let source = fs.readFileSync(path.join(repo, file), 'utf8');
    if (file === target) {
      if (!source.includes(before)) throw new Error(`${name}: mutation anchor missing`);
      source = source.replace(before, after);
    }
    fs.writeFileSync(destination, source);
  }
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/architecture/verify-v3-managed-server-lifecycle.mjs')], {
    cwd: repo,
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  if (result.status === 0) throw new Error(`${name}: verifier accepted red mutation`);
}

console.log(`V3 managed lifecycle red fixtures passed: ${mutations.length}`);
