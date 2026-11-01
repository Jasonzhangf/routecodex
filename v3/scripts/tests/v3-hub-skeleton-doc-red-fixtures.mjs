#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const verifier = resolve(repoRoot, 'v3/scripts/architecture/verify-v3-architecture-docs.mjs');
const files = [
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-function-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
];
const originals = new Map(files.map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]));
const fixtures = [
  {
    name: 'bound Hub edge removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: 'step_id: v3-hub-req-01\n    from_node: V3HubReqInbound01ClientRaw\n    to_node: V3HubReqInbound02Normalized',
    to: 'step_id: v3-hub-req-01\n    from_node: V3HubReqInbound01ClientRaw\n    to_node: V3HubReqInbound02Normalized_REMOVED',
    diagnostic: /v3-hub-req-01 must remain adjacent/,
  },
  {
    name: 'relay D worker function map removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: 'feature_id: v3.hub_relay_gate_review_surface',
    to: 'feature_id: v3.hub_relay_gate_review_surface_REMOVED',
    diagnostic: /function map missing v3\.hub_relay_gate_review_surface/,
  },
  {
    name: 'relay request mainline reverse binding removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: '  - v3-hub-relay-req-03',
    to: '  - v3-hub-relay-req-03_REMOVED',
    diagnostic: /binds missing mainline step v3-hub-relay-req-03_REMOVED/,
  },
];
const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-hub-data-red-'));
const failures = [];
const run = () => spawnSync(process.execPath, [verifier], {
  cwd: root, encoding: 'utf8', env: { ...process.env, ROUTECODEX_V3_SOURCE_ROOT: root },
});
try {
  for (const [file, source] of originals) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  const baseline = run();
  if (baseline.status !== 0) throw new Error(`baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
  for (const fixture of fixtures) {
    const source = originals.get(fixture.file);
    if (!source.includes(fixture.from)) throw new Error(`${fixture.name}: mutation input missing`);
    writeFileSync(join(root, fixture.file), source.replace(fixture.from, fixture.to));
    const result = run();
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 1 || !fixture.diagnostic.test(output)) {
      failures.push(`${fixture.name}: wrong exit/diagnostic (${result.status}): ${output.slice(-800)}`);
    }
    writeFileSync(join(root, fixture.file), source);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error('[test:v3-hub-skeleton-doc-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-hub-skeleton-doc-red-fixtures] ok (${fixtures.length} data mutations rejected)`);
