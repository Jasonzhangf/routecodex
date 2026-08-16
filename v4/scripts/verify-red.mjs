#!/usr/bin/env node
/**
 * Canonical V4 red self-test entrypoint: every verifier red suite. A single
 * red fixture that fails to fail is a hard error. The isolation positive/red
 * matrix is owned by the positive surface (scripts/verify.mjs) and runs once
 * per verify:ci.
 */
import { run } from './_common.mjs';

const RED_SUITES = [
  ['verify-v4-feature-gap.mjs', '--red-self-test'],
  ['verify-v4-relay-continuation.mjs', '--red-self-test'],
  ['verify-v4-resource-binding.mjs', '--red-self-test'],
  ['verify-v4-v3-resource-coverage.mjs', '--red-self-test'],
];

for (const [gate, flag] of RED_SUITES) {
  run(`node scripts/architecture/${gate} ${flag}`);
}

console.log(`[v4 verify:red] OK red suites=${RED_SUITES.length}`);
