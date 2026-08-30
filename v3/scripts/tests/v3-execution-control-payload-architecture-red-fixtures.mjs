#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(v3Root, '..');
const verifierRel = 'v3/scripts/architecture/verify-v3-execution-control-payload-architecture.mjs';
const copied = [
  'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-runtime-module-registry.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-execution-control-payload-architecture.md',
  'docs/architecture/wiki/html/v3-execution-control-payload-architecture.html',
  'v3/package.json',
  'v3/scripts/architecture/render-v3-execution-control-payload-architecture.mjs',
  'v3/scripts/architecture/verify-v3-execution-control-payload-architecture.mjs',
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-provider-responses/src/health.rs',
  'v3/crates/routecodex-v3-debug/src/observability_store.rs',
  'v3/crates/routecodex-v3-config/src/lib.rs',
  'v3/crates/routecodex-v3-server/src/webui_observability.rs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
];

const cases = [
  {
    name: 'Config regains runtime observability IO export',
    file: 'v3/crates/routecodex-v3-config/src/lib.rs',
    marker: 'mod validate;\n',
    replacement: 'mod validate;\npub use routecodex_v3_debug::v3_webui_observability_read_rows;\n',
    diagnostic: /Config must not export runtime observability IO/u,
  },
  {
    name: 'lifecycle status regresses from active',
    file: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
    marker: 'status: active\n',
    replacement: 'status: runtime_red\n',
    diagnostic: /lifecycle status must be active/u,
  },
  {
    name: 'runtime-red binding is reintroduced',
    file: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
    marker: 'current_runtime_red_bindings: []\n',
    replacement: 'current_runtime_red_bindings:\n  - id: forbidden-reentry\n    symbols: [removed_executor]\n',
    diagnostic: /current runtime-red bindings must be empty/u,
  },
  {
    name: 'manifest lifecycle edge regresses from active',
    file: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
    marker: '  - step_id: v3-execution-control-attempt-admission\n    from_node: V3ExecutionControl02RecoveryDecision\n    to_node: V3ExecutionControl03AttemptReserved\n    status: active\n',
    replacement: '  - step_id: v3-execution-control-attempt-admission\n    from_node: V3ExecutionControl02RecoveryDecision\n    to_node: V3ExecutionControl03AttemptReserved\n    status: binding_pending\n',
    diagnostic: /edge v3-execution-control-attempt-admission must be active/u,
  },
  {
    name: 'call-map lifecycle edge regresses to runtime-red',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    marker: '  - step_id: v3-execution-control-attempt-admission\n    from_node: V3ExecutionControl02RecoveryDecision\n    to_node: V3ExecutionControl03AttemptReserved\n    caller_symbol: execute_v3_direct_runtime_kernel_core_resident\n    caller_file: v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs\n    callee_symbol: V3AttemptBudget::admit_transport_attempt\n    callee_file: v3/crates/routecodex-v3-runtime/src/nodes.rs\n    status: anchored\n',
    replacement: '  - step_id: v3-execution-control-attempt-admission\n    from_node: V3ExecutionControl02RecoveryDecision\n    to_node: V3ExecutionControl03AttemptReserved\n    caller_symbol: execute_v3_direct_runtime_kernel_core_resident\n    caller_file: v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs\n    callee_symbol: V3AttemptBudget::admit_transport_attempt\n    callee_file: v3/crates/routecodex-v3-runtime/src/nodes.rs\n    status: runtime_red\n',
    diagnostic: /edge v3-execution-control-attempt-admission must be active or anchored/u,
  },
  {
    name: 'removed Direct buffer symbol returns to architecture maps',
    file: 'docs/architecture/v3-function-map.yml',
    marker: '  - V3CommittedClientSseBuilder\n',
    replacement: '  - V3DirectSseAttemptBuffer\n',
    diagnostic: /target architecture maps retain removed symbol V3DirectSseAttemptBuffer/u,
  },
  {
    name: 'request budget is no longer required',
    file: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
    marker: '  per_request: required\n',
    replacement: '  per_request: optional\n',
    diagnostic: /missing budget per_request/u,
  },
  {
    name: 'disk spill becomes an undeclared fallback',
    file: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
    marker: '  disk_spill: forbidden\n',
    replacement: '  disk_spill: allowed\n',
    diagnostic: /initial disk spill must be forbidden/u,
  },
  {
    name: 'local resource failure attribution disappears',
    file: 'docs/architecture/manifests/v3.execution_control_payload_architecture.mainline.yml',
    marker: '  - LocalResourceExhausted\n',
    replacement: '',
    diagnostic: /missing failure kind LocalResourceExhausted/u,
  },
  {
    name: 'attempt budget resource disappears',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    marker: '  - resource_id: v3.execution.attempt_budget\n',
    replacement: '  - resource_id: v3.execution.attempt_budget_removed\n',
    diagnostic: /missing manifest resource v3\.execution\.attempt_budget/u,
  },
  {
    name: 'resident lifecycle feature disappears',
    file: 'docs/architecture/v3-function-map.yml',
    marker: '- feature_id: v3.execution_request_lifecycle\n',
    replacement: '- feature_id: v3.execution_request_lifecycle_removed\n',
    diagnostic: /missing feature v3\.execution_request_lifecycle/u,
  },
  {
    name: 'attempt admission endpoints drift',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    marker: '  - step_id: v3-execution-control-attempt-admission\n    from_node: V3ExecutionControl02RecoveryDecision\n',
    replacement: '  - step_id: v3-execution-control-attempt-admission\n    from_node: V3ExecutionControl01RequestAccepted\n',
    diagnostic: /edge endpoints drift v3-execution-control-attempt-admission/u,
  },
  {
    name: 'runtime responsibility contract disappears',
    file: 'docs/architecture/v3-runtime-module-registry.yml',
    marker: '  - contract_id: v3.execution_control_payload.runtime\n',
    replacement: '  - contract_id: v3.execution_control_payload.runtime_removed\n',
    diagnostic: /missing responsibility v3\.execution_control_payload\.runtime/u,
  },
  {
    name: 'verification feature disappears',
    file: 'docs/architecture/v3-verification-map.yml',
    marker: '- feature_id: v3.execution_control_payload_architecture\n',
    replacement: '- feature_id: v3.execution_control_payload_architecture_removed\n',
    diagnostic: /missing verification feature/u,
  },
  {
    name: 'architecture docs gate omits verifier',
    file: 'v3/package.json',
    marker: ' && npm run verify:v3-execution-control-payload-architecture',
    replacement: '',
    diagnostic: /architecture docs gate must include execution-control verifier/u,
  },
  {
    name: 'generated markdown is hand edited',
    file: 'docs/architecture/wiki/v3-execution-control-payload-architecture.md',
    marker: '# V3 Execution Control / Payload Architecture',
    replacement: '# Stale Execution Architecture',
    diagnostic: /generated file stale/u,
  },
  {
    name: 'generated html is hand edited',
    file: 'docs/architecture/wiki/html/v3-execution-control-payload-architecture.html',
    marker: '<title>V3 Execution Control / Payload Architecture</title>',
    replacement: '<title>Stale Execution Architecture</title>',
    diagnostic: /generated file stale/u,
  },
  {
    name: 'success receipt field becomes externally constructible',
    file: 'v3/crates/routecodex-v3-runtime/src/nodes.rs',
    marker: '    _runtime_sealed: (),\n',
    replacement: '    pub _runtime_sealed: (),\n',
    diagnostic: /success receipt field must remain private/u,
  },
  {
    name: 'provider health success drops success receipt witness',
    file: 'v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs',
    marker: '        _receipt: &crate::nodes::V3AttemptSuccessReceipt,\n',
    replacement: '        _receipt: &(),\n',
    diagnostic: /provider health success must require success receipt/u,
  },
  {
    name: 'execution skeleton regains concrete compatibility profile branch',
    file: 'v3/crates/routecodex-v3-runtime/src/kernel.rs',
    marker: 'V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape',
    replacement: 'V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape /* responses:deepseek-console-go */',
    diagnostic: /execution skeleton must not inspect compatibility profile strings/u,
  },
  {
    name: 'health persistence enqueue disappears',
    file: 'v3/crates/routecodex-v3-provider-responses/src/health.rs',
    marker: 'writer.enqueue(provider_cooldown_persistence_entries(state));',
    replacement: 'let _ = writer;',
    diagnostic: /health mutation must enqueue lock-free persistence projection/u,
  },
  {
    name: 'observability writer runs before request mutex release',
    file: 'v3/crates/routecodex-v3-server/src/webui_observability.rs',
    marker: '        drop(inner);\n        if let Some(writer) = self.persistence_writer.as_ref() {\n',
    replacement: '        if let Some(writer) = self.persistence_writer.as_ref() {\n',
    diagnostic: /observability persistence must enqueue after releasing request mutex/u,
  },
  {
    name: 'exec shutdown drops persistence flush receipt',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    marker: '        self.front_transport_broker.close_active_client_transports();\n        self.flush_runtime_persistence();\n',
    replacement: '        self.front_transport_broker.close_active_client_transports();\n',
    diagnostic: /exec shutdown must await persistence flush receipts/u,
  },
];

const failures = [];
for (const fixture of cases) {
  const root = mkdtempSync(path.join(tmpdir(), 'v3-execution-control-arch-red-'));
  try {
    const nodeModules = path.resolve(repoRoot, '../../node_modules');
    if (existsSync(nodeModules)) {
      symlinkSync(nodeModules, path.join(root, 'node_modules'), 'dir');
    }
    for (const rel of copied) {
      const target = path.join(root, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(repoRoot, rel), target, { recursive: true });
    }
    const target = path.join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    if (!source.includes(fixture.marker)) {
      failures.push(`${fixture.name}: mutation marker missing`);
      continue;
    }
    const mutated = source.replace(fixture.marker, fixture.replacement);
    if (mutated === source) {
      failures.push(`${fixture.name}: mutation did not change ${fixture.file}`);
      continue;
    }
    writeFileSync(target, mutated, 'utf8');
    const result = spawnSync(process.execPath, [verifierRel], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: verifier unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-1400)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-execution-control-payload-architecture-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-execution-control-payload-architecture-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
