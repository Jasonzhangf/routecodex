#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repo, 'v3/scripts/architecture/verify-v3-entry-protocol-endpoint-binding.mjs');
const copied = [
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
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
    name: 'remove Gemini runtime owner',
    path: 'docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml',
    mutate: (source) => source.replace(
      '    runtime_owner_symbol: execute_v3_gemini_relay_runtime_with_default_transport\n',
      '',
    ),
    diagnostic: /gemini implemented binding must declare runtime owner symbol\/path/u,
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
let baselineChecked = false;
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-entry-binding-red-'));
  try {
    const write = (rel, source) => {
      mkdirSync(dirname(resolve(root, rel)), { recursive: true });
      writeFileSync(resolve(root, rel), source);
    };
    for (const rel of copied) write(rel, readFileSync(resolve(repo, rel), 'utf8'));
    const manifest = YAML.parse(readFileSync(resolve(root, copied.at(-1)), 'utf8'));
    const declarations = new Map();
    const serverFile = 'v3/crates/routecodex-v3-server/src/lib.rs';
    const routes = ['.route("/v1/models", get(models_endpoint))'];
    for (const binding of manifest.entry_protocol_bindings) {
      for (const endpoint of binding.endpoint_patterns) routes.push(`.route("${endpoint}", post(handler))`);
      if (!binding.runtime_owner_path || !binding.runtime_owner_symbol) continue;
      if (!declarations.has(binding.runtime_owner_path)) declarations.set(binding.runtime_owner_path, new Set());
      declarations.get(binding.runtime_owner_path).add(`pub fn ${binding.runtime_owner_symbol}() {}`);
    }
    for (const [file, source] of declarations) write(file, [...source].join('\n'));
    write(serverFile, `${[...(declarations.get(serverFile) ?? [])].join('\n')}\n${routes.join('\n')}`);
    write('v3/crates/routecodex-v3-config/src/validate.rs', 'const HUB_V1_ENTRY_PROTOCOLS: [&str; 4] = ["responses", "anthropic", "openai_chat", "gemini"];');
    const options = { cwd: root, encoding: 'utf8', env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root } };
    if (!baselineChecked) {
      const baseline = spawnSync(process.execPath, [verifier], options);
      if (baseline.status !== 0) throw new Error(`fixture baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
      baselineChecked = true;
    }
    const target = resolve(root, testCase.path);
    const original = readFileSync(target, 'utf8');
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change ${testCase.path}`);
      continue;
    }
    writeFileSync(target, mutated);
    const result = spawnSync(process.execPath, [verifier], options);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 1) failures.push(`${testCase.name}: unexpected verifier exit ${result.status}`);
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
