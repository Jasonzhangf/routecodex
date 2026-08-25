#!/usr/bin/env node
// Candidate boundary: baseline delta remains source-only until wiring.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const map = fs.readFileSync(path.join(root, 'docs/architecture/v3-v4-semantic-parity-map.yml'), 'utf8');
const required = ['canonical_inputs:', 'coverage:', 'v3_resources:', 'features:', 'stages:'];
const missing = required.filter((marker) => !map.includes(marker));
if (missing.length > 0) {
  console.error(`V4-PARITY-002 FAIL missing ${missing.join(',')}`);
  process.exit(1);
}
if (process.argv[2] === '--red-self-test') {
  const mutated = map.replace('coverage:', 'coverage_removed:');
  if (required.every((marker) => mutated.includes(marker))) {
    console.error('[V4-PARITY-002] RED FAIL mutation was not rejected');
    process.exit(1);
  }
  console.log('[V4-PARITY-002] RED OK coverage mutation rejected');
  process.exit(0);
}
if (process.argv[2] === '--boundary-self-test') {
  if (!map.includes('coverage:')) process.exit(1);
  console.log('[V4-PARITY-002] BOUNDARY OK coverage closure');
  process.exit(0);
}
if (process.argv.length > 2) { console.error('MODE_INVALID'); process.exit(2); }
console.log('[V4-PARITY-002] OK baseline delta inputs and coverage lock');
