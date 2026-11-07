#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = join(root, 'v3/scripts/architecture/verify-v3-provider-action-gate.mjs');
const source = 'v3/crates/routecodex-v3-runtime/src/provider_action_gate.rs';
const manifest = 'docs/architecture/manifests/v3.provider_action_gate.mainline.yml';
const callMap = 'docs/architecture/v3-mainline-call-map.yml';
const copied = [
  source,
  'v3/crates/routecodex-v3-runtime/src/provider_precool_hold.rs',
  manifest,
  callMap,
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
];
const cases = [
  { file: manifest, from: 'request_waiter: forbidden', to: 'request_waiter: allowed', name: 'request waiter declaration' },
  { file: callMap, from: 'step_id: v3-provider-action-gate-02', to: 'step_id: missing-provider-observation-edge', name: 'missing observation binding' },
  { file: source, from: null, to: '\nstruct V3ProviderActionWaiter;\n', name: 'retired request waiter type' },
];
const fixture = mkdtempSync(join(tmpdir(), 'rcc-provider-observation-fixture-'));
const run = () => spawnSync(process.execPath, [verifier], {
  env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: fixture }, encoding: 'utf8',
});
try {
  for (const rel of copied) {
    const target = join(fixture, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, rel), target);
  }
  const baseline = run();
  if (baseline.status !== 0) {
    throw new Error(`baseline static gate failed:\n${baseline.stdout ?? ''}${baseline.stderr ?? ''}`);
  }
  for (const test of cases) {
    const file = join(fixture, test.file);
    const original = readFileSync(file, 'utf8');
    if (test.from && !original.includes(test.from)) throw new Error(`missing fixture input: ${test.name}`);
    const mutated = test.from ? original.replace(test.from, test.to) : original + test.to;
    writeFileSync(file, mutated);
    const result = run();
    writeFileSync(file, original);
    if (result.status !== 1) throw new Error(`fixture did not reject ${test.name}: ${result.stderr ?? result.error ?? result.status}`);
    process.stdout.write(`PASS static rejection: ${test.name}\n`);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
