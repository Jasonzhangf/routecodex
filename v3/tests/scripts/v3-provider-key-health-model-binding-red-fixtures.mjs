#!/usr/bin/env node
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT || process.cwd();
const script = new URL('../scripts/architecture/verify-v3-provider-key-health-model-binding.mjs', import.meta.url);

async function runMutation(mutate) {
  const root = await mkdtemp(join(tmpdir(), 'rcc-key-health-gate-'));
  await cp(join(sourceRoot, 'docs'), join(root, 'docs'), { recursive: true });
  await cp(join(sourceRoot, 'v3'), join(root, 'v3'), {
    recursive: true,
    filter: (source) => !source.includes('/target/') && !source.includes('/build-control/'),
  });
  await mutate(root);
  return spawnSync(process.execPath, [script.pathname], {
    encoding: 'utf8',
    env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
  });
}

async function replaceOnce(root, path, from, to) {
  const file = join(root, path);
  const text = await readFile(file, 'utf8');
  if (!text.includes(from)) throw new Error(`red fixture target disappeared: ${from}`);
  await writeFile(file, text.replace(from, to));
}

const mutations = [
  ['wrong error-chain source', async (root) => replaceOnce(
    root,
    'docs/architecture/v3-mainline-call-map.yml',
    'from_node: V3Error02Classified',
    'from_node: V3Error05ExecutionDecision',
  )],
  ['fake target caller', async (root) => replaceOnce(
    root,
    'docs/architecture/v3-mainline-call-map.yml',
    'caller_symbol: V3TargetInterpreter::select_available_with_health',
    'caller_symbol: select_v3_target_from_expanded_with_scheduling',
  )],
  ['unregistered scheduling writer', async (root) => replaceOnce(
    root,
    'docs/architecture/v3-resource-operation-map.yml',
    'allowed_writers: [V3ProviderHealthStore::scheduling_projection]',
    'allowed_writers: [V3ProviderAvailabilityProjected]',
  )],
];

for (const [name, mutate] of mutations) {
  const result = await runMutation(mutate);
  if (result.status === 0) {
    console.error(`[test:v3-provider-key-health-model-binding-red-fixtures] accepted invalid ${name}`);
    process.exit(1);
  }
}

console.log('[test:v3-provider-key-health-model-binding-red-fixtures] ok');
