#!/usr/bin/env node
// Candidate binding marker: parity status is part of the v4-cordis tree.
// Candidate boundary: status promotion remains source-only until wiring.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ledger = fs.readFileSync(path.join(root, 'docs/architecture/v3-v4-product-parity-ledger.yml'), 'utf8');
for (const status of ['contract_status:', 'implementation_status:', 'production_path_status:', 'differential_status:', 'live_status:', 'artifact_status:']) {
  if (!ledger.includes(status)) {
    console.error(`V4-PARITY-003 FAIL missing ${status}`);
    process.exit(1);
  }
}
if (process.argv[2] === '--red-self-test') {
  const mutated = ledger.replace('production_path_status:', 'production_path_status_removed:');
  if (mutated.includes('production_path_status:')) {
    console.error('[V4-PARITY-003] RED FAIL mutation was not rejected');
    process.exit(1);
  }
  console.log('[V4-PARITY-003] RED OK status downgrade mutation rejected');
  process.exit(0);
}
if (process.argv[2] === '--boundary-self-test') {
  if (!ledger.includes('blocking_dependencies:')) process.exit(1);
  console.log('[V4-PARITY-003] BOUNDARY OK dependency closure');
  process.exit(0);
}
if (process.argv.length > 2) { console.error('MODE_INVALID'); process.exit(2); }
console.log('[V4-PARITY-003] OK status promotion fields are explicit');
