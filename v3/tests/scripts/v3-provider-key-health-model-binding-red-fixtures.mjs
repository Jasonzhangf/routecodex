#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repoRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repoRoot, 'v3/scripts/architecture/verify-v3-provider-key-health-model-binding.mjs');
const mainlinePath = 'docs/architecture/v3-mainline-call-map.yml';
const resourcesPath = 'docs/architecture/v3-resource-operation-map.yml';
const mainline = YAML.parse(readFileSync(join(repoRoot, mainlinePath), 'utf8'));
const resources = YAML.parse(readFileSync(join(repoRoot, resourcesPath), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'rcc-key-health-gate-'));
const chain = (map) => map.chains.find((row) => row.chain_id === 'v3.provider_key_health_model_granularity');

function run(map, resourceMap) {
  writeFileSync(join(root, mainlinePath), YAML.stringify(map));
  writeFileSync(join(root, resourcesPath), YAML.stringify(resourceMap));
  const result = spawnSync(process.execPath, [verifier], {
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
  });
  assert.ifError(result.error);
  return result;
}

try {
  mkdirSync(join(root, 'docs/architecture'), { recursive: true });
  const baseline = run(mainline, resources);
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const cases = [
    ['wrong error-chain source', (map) => {
      chain(map).edges.find((edge) => edge.step_id === 'v3-provider-key-health-model-01').from_node = 'V3Error05ExecutionDecision';
    }, /wrong adjacent nodes/],
    ['wrong target caller', (map) => {
      chain(map).edges.find((edge) => edge.step_id === 'v3-provider-key-health-model-03').caller_symbol = 'select_v3_target_from_expanded_with_scheduling';
    }, /declared caller\/callee/],
    ['unregistered scheduling writer', (_map, resourceMap) => {
      resourceMap.resources.find((row) => row.resource_id === 'v3.provider.scheduling_projection').allowed_writers = ['V3ProviderAvailabilityProjected'];
    }, /does not allow writer/],
  ];
  for (const [name, mutate, diagnostic] of cases) {
    const map = structuredClone(mainline);
    const resourceMap = structuredClone(resources);
    mutate(map, resourceMap);
    const result = run(map, resourceMap);
    assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, diagnostic, name);
  }
  console.log(`[test:v3-provider-key-health-model-binding-red-fixtures] ok (${cases.length} data mutations rejected)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
