#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const admissionRoot = resolve(v3Root, 'build-contracts', 'architecture-admission', 'repo');
const verifier = resolve(v3Root, 'scripts/architecture/verify-v3-selected-provider-model-binding.mjs');
const copied = [
  'package.json',
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-provider-responses/src',
  'v3/crates/routecodex-v3-target/src',
  'v3/crates/routecodex-v3-virtual-router/src',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.selected_provider_model_binding.mainline.yml',
  'docs/architecture/wiki/v3-selected-provider-model-binding.md',
  'docs/architecture/wiki/html/v3-selected-provider-model-binding.html',
  'docs/design/v3-selected-provider-model-binding.md',
  'docs/goals/v3-selected-provider-model-binding-test-design.md',
  '.agents/skills/rcc-dev-skills/references/96-v3-selected-provider-model-binding-sop.md',
];
const cases = [
  {
    name: 'Direct skips shared binding',
    path: 'v3/crates/routecodex-v3-runtime/src/hooks.rs',
    mutate: (source) => source.replace('crate::selected_provider_model_binding::bind_v3_selected_provider_model(', 'crate::selected_provider_model_binding::removed_binding('),
    diagnostic: /Direct must bind selected model before Provider12 wire build/u,
  },
  {
    name: 'Relay skips shared binding',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs',
    mutate: (source) => source.replace('bind_v3_selected_provider_model(provider_protocol_payload, selected)', 'Ok(V3SelectedProviderModelBinding::from_unbound(provider_protocol_payload))'),
    diagnostic: /Relay protocol payload builder must call the shared selected-model owner/u,
  },
  {
    name: 'Provider wire silently repairs stale model',
    path: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutate: (source) => source.replace('let actual_model = current_request_body', 'current_request_body.insert("model".to_string(), Value::String(target.wire_model.clone()));\n    let actual_model = current_request_body'),
    diagnostic: /Provider12 must validate model equality, not repair/u,
  },
  {
    name: 'Provider wire loosely trims a mismatched model',
    path: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutate: (source) => source.replace('.and_then(Value::as_str)\n        .map(str::to_string);', '.and_then(Value::as_str)\n        .map(str::trim)\n        .map(str::to_string);'),
    diagnostic: /missing \.and_then\(Value::as_str\)/u,
  },
  {
    name: 'second selected-model writer appears',
    path: 'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
    mutate: (source) => source.replace('let mut responses_payload = Map::new();', 'let mut responses_payload = Map::new();\n    let wire_model = "illegal";\n    responses_payload.insert("model".to_string(), Value::String(wire_model.to_string()));'),
    diagnostic: /selected wire-model semantic write must have one owner/u,
  },
  {
    name: 'feature owner becomes design-only',
    path: 'docs/architecture/v3-function-map.yml',
    mutate: (source) => source.replace('- feature_id: v3.route_selected_provider_model_binding\n  status: active', '- feature_id: v3.route_selected_provider_model_binding\n  status: design'),
    diagnostic: /must exist with status active/u,
  },
  {
    name: 'build stops running model-binding gate',
    path: 'package.json',
    mutate: (source) => source.replace(
      '"build:v3-cli": "npm run verify:v3-architecture-ci && npm run verify:v3-debug-payload-budget && npm run verify:v3-selected-provider-model-binding',
      '"build:v3-cli": "npm run verify:v3-architecture-ci && npm run verify:v3-debug-payload-budget',
    ),
    diagnostic: /build:v3-cli must run npm run verify:v3-selected-provider-model-binding/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-model-binding-red-'));
  try {
    for (const rel of copied) {
      const source = rel === 'package.json'
        ? resolve(v3Root, rel)
        : rel.startsWith('v3/')
          ? resolve(v3Root, rel.slice('v3/'.length))
          : resolve(admissionRoot, rel);
      cpSync(source, resolve(root, rel), { recursive: true });
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, 'utf8');
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status === 0) failures.push(`${testCase.name}: verifier unexpectedly passed`);
    else if (!testCase.diagnostic.test(output)) failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-1200)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-selected-provider-model-binding-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-selected-provider-model-binding-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
