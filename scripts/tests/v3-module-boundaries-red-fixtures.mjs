#!/usr/bin/env node

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const verifier = resolve(repo, 'scripts/architecture/verify-v3-module-boundaries.mjs');
const required = [
  'v3/crates',
  'docs/architecture/v3-build-tool-module-registry.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
];

const cases = [
  {
    name: 'runtime source owner is duplicated',
    mutate: (source) => source.replace(
      'source_modules:\n',
      'source_modules:\n  - module_id: crate.routecodex-v3-runtime-duplicate\n    owner_feature_id: v3.module_decomposition\n    owned_path: v3/crates/routecodex-v3-runtime\n    allowed_dependencies: [routecodex-v3-config, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-provider-responses, routecodex-v3-route-classifier, routecodex-v3-sse, routecodex-v3-target, routecodex-v3-virtual-router]\n',
    ),
    diagnostic: /exactly one module owner/u,
  },
  {
    name: 'runtime Cargo dependency edge is undeclared',
    mutate: (source) => source.replace(
      'allowed_dependencies: [routecodex-v3-config, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-provider-responses, routecodex-v3-route-classifier, routecodex-v3-sse, routecodex-v3-target, routecodex-v3-virtual-router]',
      'allowed_dependencies: [routecodex-v3-config, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-provider-responses, routecodex-v3-route-classifier, routecodex-v3-sse, routecodex-v3-target]',
    ),
    diagnostic: /undeclared Cargo edge/u,
  },
  {
    name: 'runtime declares a nonexistent dependency edge',
    mutate: (source) => source.replace(
      'allowed_dependencies: [routecodex-v3-config, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-provider-responses, routecodex-v3-route-classifier, routecodex-v3-sse, routecodex-v3-target, routecodex-v3-virtual-router]',
      'allowed_dependencies: [routecodex-v3-config, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-provider-responses, routecodex-v3-route-classifier, routecodex-v3-sse, routecodex-v3-target, routecodex-v3-virtual-router, routecodex-v3-nonexistent]',
    ),
    diagnostic: /nonexistent Cargo edge/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const root = mkdtempSync(join(tmpdir(), 'v3-module-boundaries-red-'));
  try {
    for (const relative of required) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(repo, relative), target, {
        recursive: true,
        filter: (path) => !path.split('/').includes('target'),
      });
    }
    const registryPath = join(root, 'docs/architecture/v3-build-tool-module-registry.yml');
    const original = readFileSync(registryPath, 'utf8');
    const mutated = testCase.mutate(original);
    if (mutated === original) {
      failures.push(`${testCase.name}: mutation did not change registry`);
      continue;
    }
    writeFileSync(registryPath, mutated);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0 || !testCase.diagnostic.test(output)) {
      failures.push(`${testCase.name}: verifier did not reject expected drift`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:v3-module-boundaries-red-fixtures] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-module-boundaries-red-fixtures] PASS (${cases.length} mutations rejected)`);
