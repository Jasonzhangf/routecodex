#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const harness = resolve(repoRoot, 'v3/scripts/tests/v3-anthropic-relay-controlled-replay-harness.mjs');
const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-anthropic-relay-red-'));
const evidence = join(root, 'evidence.json');
try {
  const result = spawnSync(process.execPath, [
    harness,
    '--fixture-root', resolve(repoRoot, 'v3/fixtures/anthropic-relay-controlled-upstream'),
    '--evidence', evidence,
  ], { cwd: repoRoot, encoding: 'utf8', env: withoutDriver(process.env) });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 1) throw new Error(`unwired harness exited ${result.status}; expected wiring_missing failure`);
  if (!/V3_ANTHROPIC_RELAY_WIRING_MISSING/.test(output)) throw new Error(`wrong red diagnostic: ${output.slice(-800)}`);
  const value = JSON.parse(readFileSync(evidence, 'utf8'));
  validateEvidence(value);
  console.log(`[test:v3-anthropic-relay-controlled-replay-harness-red-fixtures] ok (${value.missing_adjacent_edges.length} missing adjacent edges diagnosed)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function withoutDriver(environment) {
  const copy = { ...environment };
  delete copy.V3_ANTHROPIC_RELAY_DRIVER;
  return copy;
}
function validateEvidence(value) {
  const exact = ['schema_version', 'harness_id', 'status', 'cases', 'missing_adjacent_edges', 'diagnostic'];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exact.sort())) throw new Error('evidence top-level fields differ from strict schema');
  if (value.schema_version !== 1 || value.harness_id !== 'v3.anthropic_relay_controlled_replay') throw new Error('evidence identity mismatch');
  if (value.status !== 'wiring_missing') throw new Error(`expected wiring_missing, got ${value.status}`);
  if (!Array.isArray(value.cases) || value.cases.length !== 4 || value.cases.some((item) => item.status !== 'not_run' || item.provider_capture_count !== 0)) throw new Error('unwired cases must remain not_run with zero captures');
  if (!Array.isArray(value.missing_adjacent_edges) || value.missing_adjacent_edges.length < 1) throw new Error('missing adjacent edge diagnostics absent');
  if (!value.diagnostic.includes('V3_ANTHROPIC_RELAY_WIRING_MISSING')) throw new Error('missing wiring diagnostic absent from evidence');
}
