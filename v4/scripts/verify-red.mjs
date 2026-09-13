#!/usr/bin/env node
/**
 * Canonical V4 red self-test entrypoint: every verifier red suite. A single
 * red fixture that fails to fail is a hard error. The isolation positive/red
 * matrix is owned by the positive surface (scripts/verify.mjs) and runs once
 * per verify:ci.
 */
import { runIndependent, reportIndependentFailures } from './_common.mjs';
import { RED_SUITES } from './_gate-matrix.mjs';

const failures = runIndependent(RED_SUITES.map(([gate, flag]) => ({
  label: `red:${gate} ${flag}`,
  command: `node scripts/architecture/${gate} ${flag}`,
})));
if (failures.length > 0) {
  reportIndependentFailures('verify:red', failures);
  process.exit(1);
}

console.log(`[v4 verify:red] OK red suites=${RED_SUITES.length}`);
