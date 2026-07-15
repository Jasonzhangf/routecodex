#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const files = [
  'v3/crates/routecodex-v3-lifecycle/src/lib.rs',
  'v3/crates/routecodex-v3-cli/src/main.rs',
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
  ['remove foreign control reaping guard', 'v3/crates/routecodex-v3-lifecycle/src/lib.rs', 'foreign_control_record_is_never_reaped_from_terminal_state', 'removed_foreign_control_reaping_guard'],
  ['remove config source identity', 'v3/crates/routecodex-v3-config/src/store.rs', 'pub struct V3ConfigLoadedSnapshot', 'pub struct RemovedConfigLoadedSnapshot'],
  ['remove PID cache resource', 'docs/architecture/v3-resource-operation-map.yml', 'v3.lifecycle.pid_cache', 'v3.lifecycle.removed_pid_cache'],
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
