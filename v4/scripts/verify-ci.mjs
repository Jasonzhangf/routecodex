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
run('node scripts/architecture/verify-v4-control-event-arc.mjs');
run('node scripts/architecture/verify-v4-control-event-arc.mjs --red-self-test');
run('node scripts/test.mjs');
run('node scripts/verify.mjs');
run('node scripts/verify-red.mjs');
console.log('[v4 verify:ci] OK complete admission matrix');
