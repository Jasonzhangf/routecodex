#!/usr/bin/env node
/**
 * Complete V4 admission matrix: workspace tests + the positive surface (which
 * owns the locked release build, architecture gates, consumers, active index,
 * and the isolation matrix) + architecture red suites. Root CI and root npm
 * aliases call only this entrypoint.
 */
import { run } from './_common.mjs';

run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');
// V4-LAYER-PREFLIGHT-END
// Clean-checkout CI verifies the runtime admission contract. Deployed probes
// remain in the explicit `verify`/release entrypoint after installation.
process.env.RCCV4_REAL_RUNTIME_ADMISSION_MODE = 'contract';
run('node scripts/test.mjs');
run('node scripts/verify.mjs');
run('node scripts/verify-red.mjs');
console.log('[v4 verify:ci] OK source matrix; deployed release admission is separate');
