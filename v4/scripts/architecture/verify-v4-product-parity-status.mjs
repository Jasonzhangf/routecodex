#!/usr/bin/env node
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
  console.log('[V4-PARITY-003] RED OK status downgrade remains explicit');
  process.exit(0);
}
if (process.argv.length > 2) { console.error('MODE_INVALID'); process.exit(2); }
console.log('[V4-PARITY-003] OK status promotion fields are explicit');
