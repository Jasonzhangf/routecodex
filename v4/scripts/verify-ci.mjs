#!/usr/bin/env node
/**
 * Complete V4 admission matrix: workspace tests + the positive surface (which
 * owns the release build, architecture gates, consumers,
 * and the isolation matrix) + architecture red suites. Root CI and root npm
 * aliases call only this entrypoint.
 */
import { run } from './_common.mjs';

run('node scripts/test.mjs');
run('node scripts/verify.mjs');
run('node scripts/verify-red.mjs');
console.log('[v4 verify:ci] OK complete admission matrix');
