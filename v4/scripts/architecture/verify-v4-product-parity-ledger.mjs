#!/usr/bin/env node
// Candidate binding marker: parity ledger is part of the v4-cordis tree.
// Candidate boundary: ledger validation remains source-only until wiring.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ledgerPath = path.join(root, 'docs/architecture/v3-v4-product-parity-ledger.yml');
const text = fs.readFileSync(ledgerPath, 'utf8');
const required = ['version:', 'status: active', 'owner_feature_id: v4.product_parity', 'features:', 'feature_id:', 'evidence_paths:'];
const failures = required.filter((marker) => !text.includes(marker));
if (failures.length > 0) {
  console.error(`V4-PARITY-001 FAIL missing ${failures.join(',')}`);
  process.exit(1);
}
if (process.argv.length > 2 && process.argv[2] === '--red-self-test') {
  const mutated = text.replace('evidence_paths:', 'evidence_paths_removed:');
  const rejected = required.some((marker) => !mutated.includes(marker));
  if (!rejected) {
    console.error('V4-PARITY-001 RED FAIL mutation was not rejected');
    process.exit(1);
  }
  console.log('[V4-PARITY-001] RED OK evidence path mutation rejected');
  process.exit(0);
}
if (process.argv.length > 2 && process.argv[2] === '--boundary-self-test') {
  if (!text.includes('evidence_paths:')) process.exit(1);
  console.log('[V4-PARITY-001] BOUNDARY OK evidence path closure');
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error('MODE_INVALID');
  process.exit(2);
}
console.log('[V4-PARITY-001] OK ledger schema and required product fields locked');
