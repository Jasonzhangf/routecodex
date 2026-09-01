#!/usr/bin/env node
// v4-cordis parity candidate binding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const map = fs.readFileSync(path.join(root, 'docs/architecture/v3-v4-semantic-parity-map.yml'), 'utf8');
const requiredStages = ['request:', 'response:', 'error:', 'config:', 'verification_gates:', 'checkpoint_evidence:'];
const missing = requiredStages.filter((marker) => !map.includes(marker));
if (missing.length > 0) {
  console.error(`V4-PARITY-HARNESS-001 FAIL missing ${missing.join(',')}`);
  process.exit(1);
}

const fixturePath = path.join(root, 'tests/resources/parity/differential-harness-v1.json');
const controlKey = /^(metadata|client_metadata|route|routing|switch|switching|continuation|retry|provider_selection|provider|health|debug|snapshot|error|scope|stopless|servertool|control)$/i;

const readFixture = (file = fixturePath) => JSON.parse(fs.readFileSync(file, 'utf8'));

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};

const diffPaths = (left, right, prefix = '$') => {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) paths.push(...diffPaths(left[index], right[index], `${prefix}[${index}]`));
    return paths;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => diffPaths(left[key], right[key], `${prefix}.${key}`));
  }
  return [prefix];
};

const controlPaths = (value, prefix = '$') => {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(controlKey.test(key) ? [`${prefix}.${key}`] : []),
    ...controlPaths(child, `${prefix}.${key}`),
  ]);
};

const assertFixture = (fixture) => {
  if (fixture.fixture_kind !== 'deterministic_contract_fixture') throw new Error('fixture kind must be deterministic_contract_fixture');
  if (fixture.provider_network_send !== false) throw new Error('provider network send must be false');
  if (fixture.provider_requests_replayed !== 0) throw new Error('provider requests must not be replayed');
  if (!fixture.old?.wire || !fixture.old?.raw_response || !fixture.new?.wire || !fixture.new?.raw_response) {
    throw new Error('old/new wire and raw response are required');
  }
  const forbidden = [
    ...controlPaths(fixture.old.wire, '$.old.wire'),
    ...controlPaths(fixture.new.wire, '$.new.wire'),
    ...controlPaths(fixture.old.raw_response, '$.old.raw_response'),
    ...controlPaths(fixture.new.raw_response, '$.new.raw_response'),
  ];
  if (forbidden.length > 0) throw new Error(`control-plane fields in business evidence: ${forbidden.join(',')}`);
  const allowed = new Set(fixture.intentional_differences ?? []);
  const wireDiff = diffPaths(stable(fixture.old.wire), stable(fixture.new.wire));
  const responseDiff = diffPaths(stable(fixture.old.raw_response), stable(fixture.new.raw_response));
  const unexplained = [...wireDiff.map((path) => `wire:${path}`), ...responseDiff.map((path) => `raw_response:${path}`)]
    .filter((path) => !allowed.has(path));
  if (unexplained.length > 0) throw new Error(`unexplained differential: ${unexplained.join(',')}`);
  return {wireDiff, responseDiff, fixtureId: fixture.fixture_id};
};

const mode = process.argv[2];
const fixture = readFixture(mode === '--fixture' ? process.argv[3] : fixturePath);
if (mode === '--fixture' && !process.argv[3]) {
  console.error('MODE_INVALID');
  process.exit(2);
}

if (mode === '--red-self-test') {
  const mutated = structuredClone(fixture);
  mutated.new.wire.model = 'unexplained-model-drift';
  try { assertFixture(mutated); } catch { console.log('[V4-PARITY-HARNESS-001] RED OK unexplained wire drift rejected'); process.exit(0); }
  console.error('[V4-PARITY-HARNESS-001] RED FAIL unexplained wire drift accepted');
  process.exit(1);
}
if (mode === '--boundary-self-test') {
  const mutated = structuredClone(fixture);
  mutated.new.wire.metadata = { route: 'internal-only' };
  try { assertFixture(mutated); } catch { console.log('[V4-PARITY-HARNESS-001] BOUNDARY OK control-plane leak rejected'); process.exit(0); }
  console.error('[V4-PARITY-HARNESS-001] BOUNDARY FAIL control-plane leak accepted');
  process.exit(1);
}
if (mode === '--no-replay-self-test') {
  const mutated = structuredClone(fixture);
  mutated.provider_requests_replayed = 1;
  try { assertFixture(mutated); } catch { console.log('[V4-PARITY-HARNESS-001] NEGATIVE OK duplicate provider request rejected'); process.exit(0); }
  console.error('[V4-PARITY-HARNESS-001] NEGATIVE FAIL duplicate provider request accepted');
  process.exit(1);
}
if (mode && mode !== '--fixture') {
  console.error('MODE_INVALID');
  process.exit(2);
}

try {
  const result = assertFixture(fixture);
  console.log(`[V4-PARITY-HARNESS-001] OK fixture=${result.fixtureId} wire/raw-response differential=0 provider_requests_replayed=0`);
} catch (error) {
  console.error(`[V4-PARITY-HARNESS-001] FAIL ${error.message}`);
  process.exit(1);
}
