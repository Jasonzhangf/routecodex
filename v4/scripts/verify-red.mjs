#!/usr/bin/env node
/**
 * Canonical V4 red self-test entrypoint: every verifier red suite. A single
 * red fixture that fails to fail is a hard error. The isolation positive/red
 * matrix is owned by the positive surface (scripts/verify.mjs) and runs once
 * per verify:ci.
 */
import { run } from './_common.mjs';
import { RED_SUITES, RUST_GATES_RED } from './_gate-matrix.mjs';

for (const [gate, flag] of RED_SUITES) {
  run(`node scripts/architecture/${gate} ${flag}`);
}

for (const [, command] of RUST_GATES_RED) run(command);

console.log(`[v4 verify:red] OK red suites=${RED_SUITES.length + RUST_GATES_RED.length}`);
