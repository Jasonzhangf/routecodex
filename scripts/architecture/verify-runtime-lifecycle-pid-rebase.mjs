// 2026-06-16 runtime lifecycle rebase gate.
// Scans the repo for legacy pid/stop-intent write patterns that lived directly
// under <rccUserDir>/ and verifies they have been replaced with the new helpers.
//
// Forbidden patterns:
// - join(<someHome>, `server-${port}.pid`)
// - join(<someHome>, `daemon-stop-${port}.json`)
// - `daemon-stop-${Math.floor(port)}.json` literal in the new helper module
//
// The gate is intentionally source-level: it cannot see runtime behaviour, but
// it locks the contract that legacy paths are no longer written by the code.

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const RUNTIME_LIFECYCLE_SHELLS = [
  'src/cli/commands/restart.ts',
  'src/cli/commands/start.ts',
  'src/utils/runtime-instance-registry.ts',
  'src/utils/server-runtime-pid.ts',
  'src/utils/server-runtime-stop-intent.ts'
];
const RUNTIME_LIFECYCLE_NATIVE_EXPORTS = [
  'planRuntimePidCacheWriteJson',
  'planRuntimePidCacheReadResultJson',
  'planRuntimeStopIntentWriteJson',
  'planRuntimeStopIntentConsumeJson',
  'planRuntimeInstanceWriteJson',
  'planRuntimeInstanceStatusUpdateJson',
  'planRuntimeRestartRequestJson',
  'planRuntimeStartRestartTakeoverGuardJson'
];

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const checks = [
  {
    label: 'src/index.ts must not write server-<port>.pid in <rccHome>/',
    file: 'src/index.ts',
    forbidden: [/join\(resolveRccPath\(\),\s*`server-\$\{bindPort\}\.pid`\)/],
    required: [/writeServerPidCache\(/]
  },
  {
    label: 'src/cli/commands/start.ts must use writeServerPidCache',
    file: 'src/cli/commands/start.ts',
    forbidden: [/join\(routeCodexHome,\s*`server-\$\{resolvedPort\}\.pid`\)/],
    required: [/writeServerPidCache\(/]
  },
  {
    label: 'src/utils/daemon-stop-intent.ts is a re-export only',
    file: 'src/utils/daemon-stop-intent.ts',
    forbidden: [/daemon-stop-\$\{Math\.floor\(port\)\}\.json/],
    required: [/from\s+'\.\/server-runtime-stop-intent\.js'/]
  },
  {
    label: 'src/config/user-data-paths.ts exposes runtime-lifecycle subdir',
    file: 'src/config/user-data-paths.ts',
    forbidden: [],
    required: [/runtimeLifecycle:\s*'state\/runtime-lifecycle'/]
  },
  {
    label: 'runtime lifecycle Rust owner exposes native plan functions',
    file: 'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/runtime_lifecycle.rs',
    forbidden: [],
    required: [
      /feature_id:\s*runtime\.lifecycle\.pid_cache/,
      /feature_id:\s*runtime\.lifecycle\.stop_intent/,
      /feature_id:\s*runtime\.lifecycle\.instance_registry/,
      /feature_id:\s*runtime\.lifecycle\.restart_command/,
      /feature_id:\s*runtime\.lifecycle\.start_command/,
      /plan_runtime_pid_cache_write_json/,
      /plan_runtime_pid_cache_read_result_json/,
      /plan_runtime_stop_intent_write_json/,
      /plan_runtime_stop_intent_consume_json/,
      /plan_runtime_instance_write_json/,
      /plan_runtime_instance_status_update_json/,
      /normalize_instance_status/,
      /is_status_transition_allowed/,
      /plan_runtime_restart_request_json/,
      /plan_runtime_start_restart_takeover_guard_json/
    ]
  },
  {
    label: 'runtime lifecycle host is the only runtime lifecycle native bridge surface',
    file: 'src/modules/llmswitch/bridge/runtime-lifecycle-host.ts',
    forbidden: [/from\s+['"][^'"]*runtime-lifecycle-host\.js['"]/],
    required: [
      /from\s+['"]\.\/native-exports\.js['"]/,
      /planRuntimePidCacheWrite/,
      /planRuntimePidCacheReadResult/,
      /planRuntimeStopIntentWrite/,
      /planRuntimeStopIntentConsume/,
      /planRuntimeInstanceWrite/,
      /planRuntimeInstanceStatusUpdate/,
      /planRuntimeRestartRequest/,
      /planRuntimeStartRestartTakeoverGuard/
    ]
  }
];

const failures = [];
for (const check of checks) {
  const abs = path.join(repoRoot, check.file);
  const text = readOrNull(abs);
  if (text === null) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] missing file: ${check.file}`);
    continue;
  }
  for (const pattern of check.forbidden) {
    if (pattern.test(text)) {
      failures.push(`[verify:runtime-lifecycle-pid-rebase] forbidden pattern ${pattern} in ${check.file}`);
    }
  }
  for (const pattern of check.required) {
    if (!pattern.test(text)) {
      failures.push(`[verify:runtime-lifecycle-pid-rebase] missing required pattern ${pattern} in ${check.file}`);
    }
  }
}

for (const file of RUNTIME_LIFECYCLE_SHELLS) {
  const text = readOrNull(path.join(repoRoot, file));
  if (text === null) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] missing file: ${file}`);
    continue;
  }
  if (/native-exports\.(?:js|ts)/.test(text) || /getRouterHotpathJsonBindingSync/.test(text)) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] ${file} must use runtime-lifecycle-host, not broad native-exports`);
  }
  if (!/runtime-lifecycle-host\.js/.test(text)) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] ${file} must import runtime-lifecycle-host`);
  }
}

const nativeExportsText = readOrNull(path.join(repoRoot, 'sharedmodule/llmswitch-core/native-hotpath-required-exports.json')) ?? '';
for (const exportName of RUNTIME_LIFECYCLE_NATIVE_EXPORTS) {
  if (!nativeExportsText.includes(`"${exportName}"`)) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] missing required native export ${exportName}`);
  }
}

function collectTsFiles(dir) {
  const out = [];
  const absDir = path.join(repoRoot, dir);
  if (!fs.existsSync(absDir)) {
    return out;
  }
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', 'coverage'].includes(entry.name)) {
      continue;
    }
    const rel = path.posix.join(dir, entry.name);
    if (rel.startsWith('src/modules/llmswitch/bridge/')) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(rel));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

for (const file of collectTsFiles('src')) {
  const text = readOrNull(path.join(repoRoot, file)) ?? '';
  if (/['"][^'"]*native-exports(?:\.js|\.ts)?['"]/.test(text)) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] ${file} imports broad native-exports outside the bridge`);
  }
}

if (failures.length > 0) {
  console.error('[verify:runtime-lifecycle-pid-rebase] failed');
  for (const line of failures) console.error(`- ${line}`);
  process.exit(1);
}

console.log('[verify:runtime-lifecycle-pid-rebase] ok');
console.log(`- checks: ${checks.length}`);
console.log(`- runtime shells: ${RUNTIME_LIFECYCLE_SHELLS.length}`);
