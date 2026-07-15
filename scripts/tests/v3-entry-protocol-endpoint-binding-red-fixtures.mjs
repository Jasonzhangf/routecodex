#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-entry-protocol-endpoint-binding.mjs');
const copied = [
  'package.json',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
  'docs/architecture/wiki/v3-entry-protocol-endpoint-binding.md',
  'docs/architecture/wiki/html/v3-entry-protocol-endpoint-binding.html',
  'scripts/architecture/architecture-wiki-lib.mjs',
  'v3/crates/routecodex-v3-server/src/lib.rs',
  'v3/crates/routecodex-v3-config/src/validate.rs',
  'v3/crates/routecodex-v3-config/src/types.rs',
];

const cases = [
  {
    name: 'delete Gemini binding',
    path: 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
    mutate: (source) => source.replace(/\n  - entry_protocol: gemini[\s\S]*?forbidden_fallback_behavior: "Gemini endpoint must not fall through to generic foundation pending\."\n/u, '\n'),
    diagnostic: /missing required protocol binding gemini/u,
  },
  {
    name: 'add unbound server endpoint',
    path: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutate: (source) => source.replace('.route("/v1/models", get(models_endpoint))', '.route("/v1/models", get(models_endpoint))\n        .route("/v1/unbound", post(pending_endpoint))'),
    diagnostic: /unbound business endpoint \/v1\/unbound/u,
  },
  {
    name: 'add config protocol without binding',
    path: 'v3/crates/routecodex-v3-config/src/validate.rs',
    mutate: (source) => source.replace('"openai_chat"', '"openai_chat", "legacy_chat"'),
    diagnostic: /config allowed protocol legacy_chat lacks entry binding/u,
  },
  {
    name: 'add registry binding without allowed protocol',
    path: 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
    mutate: (source) => source + '\n  - entry_protocol: legacy_chat\n    endpoint_patterns: [/v1/legacy]\n    execution_mode: relay\n    implementation_status: implemented\n    owner_feature_id: v3.entry_protocol_endpoint_binding\n    runtime_owner_symbol: legacy\n    runtime_owner_path: none\n',
    diagnostic: /unknown protocol binding legacy_chat/u,
  },
  {
    name: 'remove source verifier gate from feature map',
    path: 'docs/architecture/v3-function-map.yml',
    mutate: (source) => source.replace('      - npm run verify:v3-entry-protocol-endpoint-binding\n', ''),
    diagnostic: /feature missing required gate npm run verify:v3-entry-protocol-endpoint-binding/u,
  },
  {
    name: 'break wiki mainline node sync',
    path: 'docs/architecture/wiki/v3-entry-protocol-endpoint-binding.md',
    mutate: (source) => source.replaceAll('v3-entry-bind-04', 'v3-entry-bind-four'),
    diagnostic: /missing v3-entry-bind-04/u,
  },
  {
    name: 'remove pending owner',
    path: 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
    mutate: (source) => source.replace('    pending_owner: execute_v3_foundation_pending_runtime\n', ''),
    diagnostic: /gemini pending binding must declare pending_owner/u,
  },
  {
    name: 'add server raw path bypass branch',
    path: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutate: (source) => source.replace('let path = request.uri().path().to_string();', 'let path = request.uri().path().to_string();\n    if path == "/v1/messages" { return pending_endpoint(State(state), request).await; }'),
    diagnostic: /Server dispatcher bypasses entry protocol binding registry/u,
  },
  {
    name: 'allow binding resource into provider body',
    path: 'docs/architecture/v3-resource-operation-map.yml',
    mutate: (source) => source.replace(
      /resource_id: v3\.entry_protocol\.binding_registry[\s\S]*?may_enter_provider_body: false/u,
      (match) => match.replace('may_enter_provider_body: false', 'may_enter_provider_body: true'),
    ),
    diagnostic: /v3\.entry_protocol\.binding_registry must not enter provider\/client body/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-entry-binding-red-'));
  try {
    for (const rel of copied) cpSync(resolve(repo, rel), resolve(root, rel), { recursive: true });
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
    else if (!testCase.diagnostic.test(output)) failures.push(`${testCase.name}: wrong diagnostic: ${output.slice(-900)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-entry-protocol-endpoint-binding-red-fixtures] failed');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log(`[test:v3-entry-protocol-endpoint-binding-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
