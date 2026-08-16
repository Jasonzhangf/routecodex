#!/usr/bin/env node
/**
 * Canonical V4 positive verification: workspace release build, hermetic Active
 * restore, all V4 architecture gates, all non-workspace consumer regressions
 * through build-link, deterministic Active index generation/verification, and
 * the isolation positive/red matrix.
 *
 * This is the single owner of the V4 module/gate matrix. Root npm and CI only
 * dispatch to this surface (through verify:ci).
 */
import fs from 'node:fs';
import path from 'node:path';
import { v4Root, run } from './_common.mjs';

const ARCHITECTURE_GATES = [
  'verify-v4-active-link.mjs',
  'verify-v4-capability-isolation.mjs',
  'verify-v4-execution-binding.mjs',
  'verify-v4-feature-gap.mjs',
  'verify-v4-plane-isolation.mjs',
  'verify-v4-relay-continuation.mjs',
  'verify-v4-resource-binding.mjs',
  'verify-v4-responses-direct-compat.mjs',
  'verify-v4-semantic-parity.mjs',
  'verify-v4-skeleton-topology.mjs',
  'verify-v4-v3-resource-coverage.mjs',
];

// Non-workspace consumers are compiled and regression-tested exclusively
// through the build-link resolver against Active artifacts and registered
// source deps (mirrors the AppSDK regression command contracts).
const CONSUMER_REGRESSIONS = [
  ['routecodex-v4-edge', 'routecodex-v4-base-node'],
  ['routecodex-v4-config', 'routecodex-v4-base-node,routecodex-v4-edge'],
  ['routecodex-v4-control', 'routecodex-v4-base-node'],
  ['routecodex-v4-error', 'routecodex-v4-base-node'],
  ['routecodex-v4-runtime', 'routecodex-v4-error,routecodex-v4-base-node,routecodex-v4-control', '--source-deps', 'routecodex-v4-skeleton'],
  ['routecodex-v4-debug', 'routecodex-v4-base-node'],
  ['routecodex-v4-router', 'routecodex-v4-base-node'],
  ['routecodex-v4-provider', 'routecodex-v4-base-node'],
  ['routecodex-v4-server', 'routecodex-v4-base-node'],
];

function restoreHermeticActive() {
  const fixture = path.join(v4Root, 'tests/resources/active-link-fixture/active/lib');
  const target = path.join(v4Root, 'active/lib');
  if (!fs.existsSync(fixture)) {
    throw new Error(`[v4 verify] hermetic Active fixture missing: ${fixture}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(fixture, target, { recursive: true });
}

run('cargo build --release --manifest-path Cargo.toml --locked');
restoreHermeticActive();

for (const gate of ARCHITECTURE_GATES) {
  run(`node scripts/architecture/${gate}`);
}

for (const [consumer, deps, ...extra] of CONSUMER_REGRESSIONS) {
  const extraArgs = extra.length > 0 ? ` ${extra.join(' ')}` : '';
  run(
    `cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- test-consumer --root . --consumer ${consumer} --deps ${deps}${extraArgs}`,
  );
}

run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- gen-index --root .');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- verify-index --root .');
run('node scripts/verify-isolation.mjs');

console.log(`[v4 verify] OK gates=${ARCHITECTURE_GATES.length} consumers=${CONSUMER_REGRESSIONS.length} active-index=ok isolation=ok`);
