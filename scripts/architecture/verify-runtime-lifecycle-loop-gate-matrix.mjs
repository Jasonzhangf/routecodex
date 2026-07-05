import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const loopDir = path.join(root, 'docs/loops/runtime-lifecycle');
const matrixRel = 'docs/loops/runtime-lifecycle/gate-matrix.md';

function readRel(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function sectionFor(text, heading) {
  const marker = `### \`${heading}\``;
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const next = text.indexOf('\n### ', start + marker.length);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

const failures = [];

function requireIncludes(label, text, needles) {
  for (const needle of needles) {
    if (!text.includes(needle)) {
      failures.push(`${label} missing ${needle}`);
    }
  }
}

const matrix = readRel(matrixRel);
const packageJson = JSON.parse(readRel('package.json'));
const rowIds = [
  'release_install_sync',
  'runtime_lifecycle',
  'verification_gate_mapping',
  'webui_config_editor',
  'worker_collision',
];

requireIncludes('package.json scripts', packageJson.scripts?.['verify:runtime-lifecycle-loop-gate-matrix'] || '', [
  'scripts/architecture/verify-runtime-lifecycle-loop-gate-matrix.mjs',
]);

requireIncludes('gate matrix global entry gate', matrix, [
  '## Global L2 Entry Gate',
  '| State |',
  '| Scope |',
  '| Owner |',
  '| Mainline |',
  '| Verification |',
  '| Checker |',
  '| Worktree |',
  '| Safety |',
]);

for (const rowId of rowIds) {
  const section = sectionFor(matrix, rowId);
  if (!section) {
    failures.push(`gate matrix missing row ${rowId}`);
    continue;
  }
  requireIncludes(`gate matrix row ${rowId}`, section, [
    '| Owner |',
    '| Mainline |',
    '| Whitebox |',
    '| Blackbox |',
    '| Quality |',
    '| Evidence |',
    '| Escalate |',
  ]);
}

requireIncludes('release_install_sync row', sectionFor(matrix, 'release_install_sync'), [
  'npm run verify:function-map-build-wiring',
  'ROUTECODEX_INSTALL_VERIFY_PORT=<port>',
  'npm run install:release',
  'routecodex --version',
  'rcc --version',
  '/health.version === package.json.version',
  'no repo path leaks',
  'no symlinked `rcc-llmswitch-core`',
  'no stale live version accepted',
]);

requireIncludes('runtime_lifecycle row', sectionFor(matrix, 'runtime_lifecycle'), [
  'runtime.lifecycle.pid_cache',
  'runtime.lifecycle.stop_intent',
  'runtime.lifecycle.instance_registry',
  'runtime.lifecycle.mainline',
  'npm run verify:runtime-lifecycle-pid-rebase',
  'tests/cli/start-command.spec.ts',
  'tests/cli/stop-command.spec.ts',
  'tests/cli/restart-command.spec.ts',
  'rcc start --snap',
  'rcc start --restart --port <port>',
  'rcc stop --port <port>',
  'rcc restart --port <port>',
  '~/.rcc/logs/process-lifecycle.jsonl',
]);

requireIncludes('verification_gate_mapping row', sectionFor(matrix, 'verification_gate_mapping'), [
  'docs/architecture/function-map.yml',
  'docs/architecture/mainline-call-map.yml',
  'docs/architecture/verification-map.yml',
  'npm run verify:function-map-compile-gate',
  'npm run verify:architecture-mainline-call-map',
  'No invented symbols',
]);

requireIncludes('webui_config_editor row', sectionFor(matrix, 'webui_config_editor'), [
  'config.user_config_codec',
  'config.user_config_write_surface',
  'config.provider_config_codec',
  'config.provider_config_write_surface',
  'vr.provider_forwarder_runtime',
  'npm run test:webui',
  'npm run verify:config-ssot',
  'npm run verify:function-map-compile-gate',
  'priority',
  'weighted',
  'roundrobin',
  'No provider secret exposure',
  'no raw TOML stringify outside shared writer',
]);

requireIncludes('worker_collision row', sectionFor(matrix, 'worker_collision'), [
  'git status --short --branch',
  'git diff --name-only',
  'Never reset, checkout, broad restore, broad delete, or stage unrelated files',
]);

requireIncludes('gate matrix run log contract', matrix, [
  '## L2 Run Log Required Fields',
  '`watchlist_id`',
  '`item_id`',
  '`owner_feature_id`',
  '`mainline_edge` or `not_applicable`',
  '`owner_path`',
  '`whitebox_gates`',
  '`blackbox_gates`',
  '`checker`',
  '`evidence_paths`',
  '`residual_risk`',
]);

for (const rel of [
  'docs/loops/runtime-lifecycle/LOOP.md',
  'docs/loops/runtime-lifecycle/STATE.md',
  'docs/loops/runtime-lifecycle/loop-constraints.md',
  'docs/loops/runtime-lifecycle/loop-budget.md',
]) {
  requireIncludes(rel, readRel(rel), ['gate-matrix.md']);
}

const state = readRel('docs/loops/runtime-lifecycle/STATE.md');
requireIncludes('STATE.md', state, ['kill_switch: inactive', 'mode: L1 report-only']);
for (const rowId of rowIds) {
  requireIncludes('STATE.md watchlist', state, [rowId]);
  requireIncludes('LOOP.md matrix rows', readRel('docs/loops/runtime-lifecycle/LOOP.md'), [rowId]);
}

const runLogPath = path.join(loopDir, 'loop-run-log.md');
const runLog = fs.readFileSync(runLogPath, 'utf8').trim();
if (!runLog) {
  failures.push('loop-run-log.md must contain at least one JSONL entry');
} else {
  for (const [index, line] of runLog.split(/\n+/).entries()) {
    try {
      JSON.parse(line);
    } catch (error) {
      failures.push(`loop-run-log.md line ${index + 1} is not valid JSON: ${error.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:runtime-lifecycle-loop-gate-matrix] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:runtime-lifecycle-loop-gate-matrix] ok');
console.log(`- rows: ${rowIds.length}`);
console.log('- checks: global entry, rows, run-log contract, linked loop docs, JSONL parse');
