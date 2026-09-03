#!/usr/bin/env node
/**
 * C0 red gate: production Rust startup must not publish an epoch without a
 * real Cordis admission receipt. This gate intentionally fails on the
 * current hybrid entrypoint until the Host/Rust admission port is wired.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(
  path.join(root, 'crates/routecodex-v4-runtime-bin/src/main.rs'),
  'utf8',
);
const productionSource = source.split('#[cfg(test)]', 1)[0];
const failures = [];

if (/\n\s*cordis_service_readiness\(/.test(productionSource)) {
  failures.push('SIMULATED_CORDIS_READINESS: production startup still uses the Rust readiness mirror');
}
if (/commit_execution_epoch\(&transaction_id\)/.test(productionSource)
    && !/cordis_admission_receipt/.test(productionSource)) {
  failures.push('RUST_EPOCH_COMMIT_WITHOUT_CORDIS_RECEIPT: epoch commit has no real Cordis admission witness');
}
if (!/CordisAdmission/.test(productionSource)) {
  failures.push('CORDIS_ADMISSION_PORT_MISSING: production entry has no typed Cordis admission port');
}

if (failures.length > 0) {
  console.error('[V4-CORDIS-PRODUCTION-ADMISSION] EXPECTED RED');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('[V4-CORDIS-PRODUCTION-ADMISSION] GREEN');
