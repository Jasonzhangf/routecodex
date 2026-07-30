#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-provider-directory-config.mjs');
const copied = [
  'package.json',
  'v3/crates/routecodex-v3-config/src/provider_directory.rs',
  'v3/crates/routecodex-v3-config/src/v2_compat.rs',
  'v3/crates/routecodex-v3-config/tests/provider_directory_config_contract.rs',
  'docs/architecture/function-map.yml',
  'docs/architecture/resource-operation-map.yml',
  'docs/architecture/mainline-call-map.yml',
  'docs/architecture/verification-map.yml',
  'docs/architecture/manifests/v3.provider_directory_config.mainline.yml',
  'docs/architecture/wiki/v3-provider-directory-config.md',
  'docs/architecture/wiki/html/v3-provider-directory-config.html',
  'docs/design/v3-provider-directory-config.md',
  'docs/goals/v3-provider-directory-config-test-design.md',
];
const cases = [
  {
    name: 'provider codec adds home fallback',
    path: 'v3/crates/routecodex-v3-config/src/v2_compat.rs',
    mutate: (source) => source.replace('let path = config_dir', 'let _home = std::env::var_os("HOME");\n        let path = config_dir'),
    diagnostic: /provider source must resolve exact sibling path/u,
  },
  {
    name: 'mixed source rejection disappears',
    path: 'v3/crates/routecodex-v3-config/src/provider_directory.rs',
    mutate: (source) => source.replace('native v3 config cannot mix inline providers with provider directory sources', 'mixed sources accepted'),
    diagnostic: /missing native v3 config cannot mix inline providers/u,
  },
  {
    name: 'feature becomes design-only',
    path: 'docs/architecture/function-map.yml',
    mutate: (source) => source.replace('  - feature_id: v3.provider_directory_config_compat\n    status: active', '  - feature_id: v3.provider_directory_config_compat\n    status: design'),
    diagnostic: /must exist with status active/u,
  },
  {
    name: 'exact-path invariant disappears',
    path: 'docs/architecture/manifests/v3.provider_directory_config.mainline.yml',
    mutate: (source) => source.replace('  - referenced_provider_exact_path_only', '  - provider_path_optional'),
    diagnostic: /missing referenced_provider_exact_path_only invariant/u,
  },
  {
    name: 'build skips provider directory gate',
    path: 'package.json',
    mutate: (source) => source.replace('"build:v3-cli": "npm run verify:v3-provider-directory-config && ', '"build:v3-cli": "'),
    diagnostic: /build:v3-cli must run npm run verify:v3-provider-directory-config/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-provider-directory-red-'));
  try {
    for (const relative of copied) cpSync(resolve(repo, relative), resolve(root, relative), { recursive: true });
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

if (failures.length > 0) {
  console.error('[test:v3-provider-directory-config-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-provider-directory-config-red-fixtures] ok (${cases.length} forbidden mutations rejected)`);
