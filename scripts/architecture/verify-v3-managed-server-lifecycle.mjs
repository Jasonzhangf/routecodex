#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.ROUTECODEX_V3_SOURCE_ROOT || process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};

const lifecycle = read('v3/crates/routecodex-v3-lifecycle/src/lib.rs');
const cli = read('v3/crates/routecodex-v3-cli/src/main.rs');
const configStore = read('v3/crates/routecodex-v3-config/src/store.rs');
const configLib = read('v3/crates/routecodex-v3-config/src/lib.rs');
const configTests = read('v3/crates/routecodex-v3-config/tests/config_v3_contract.rs');
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
  'pub async fn stop', 'pub async fn run_managed_child', 'acquire_operation_lock',
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
requireText(configStore, 'pub struct V3ConfigLoadedSnapshot', 'config store source identity owner');
requireText(configStore, 'source_sha256', 'config store source identity owner');
requireText(configStore, 'Sha256::digest(source.raw_toml.as_bytes())', 'config store source identity owner');
requireText(configLib, 'V3ConfigLoadedSnapshot', 'config lib export');
requireText(configTests, 'config_source_identity_is_stable_sensitive_and_secret_free', 'config source identity test');
requireText(cliManagedTests, 'managed_child_survives_start_cli_exit_and_is_controlled_by_new_cli_processes', 'managed CLI persistence test');
requireText(cliManagedTests, 'fn stopped_instance_restarts_from_next_release_snapshot_executable()', 'managed CLI release rollover test');
requireText(cliManagedTests, 'fn copy_release_binary(', 'managed CLI release rollover helper');
requireText(cliManagedTests, 'scan_instance_files_for_secret', 'managed CLI secret scan');

for (const command of ['Start', 'Status', 'Restart', 'Stop', 'RunManagedChild'])
  requireText(cli, command, 'CLI managed command');
requireText(cli, 'V3ManagedLifecycle::new', 'CLI thin lifecycle call');
requireText(workspace, 'crates/routecodex-v3-lifecycle', 'workspace member');

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
