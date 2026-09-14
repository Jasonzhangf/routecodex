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
import { runBuild } from './build.mjs';
import {
  ARCHITECTURE_GATES,
  CONSUMER_REGRESSIONS,
  RUNTIME_BIN_REGRESSION,
  architectureCommand,
  consumerCommand,
} from './_gate-matrix.mjs';

run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');
// V4-LAYER-PREFLIGHT-END

const { runIndependent, reportIndependentFailures } = await import('./_common.mjs');

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

run('cargo run --quiet --manifest-path Cargo.toml -p routecodex-v4-skeleton --bin routecodex-v4-plan-hash -- contracts/skeleton-plan.contract.json --check');
run('cargo build --release --manifest-path Cargo.toml --locked');
restoreHermeticActive();
runBuild();
run(RUNTIME_BIN_REGRESSION);

run('node scripts/tests/verify-independent-failures.mjs');

const architectureFailures = runIndependent(ARCHITECTURE_GATES.map((gate) => ({
  label: `architecture:${gate}`,
  command: architectureCommand(gate),
})));

const consumerFailures = runIndependent(CONSUMER_REGRESSIONS.map((entry) => ({
  label: `consumer:${entry[0]}`,
  command: consumerCommand(entry),
})));

const matrixFailures = [...architectureFailures, ...consumerFailures];
if (matrixFailures.length > 0) {
  reportIndependentFailures('verify', matrixFailures);
  process.exit(1);
}

run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- gen-index --root .');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- verify-index --root .');
run('node scripts/verify-isolation.mjs');

console.log(`[v4 verify] OK gates=${ARCHITECTURE_GATES.length} consumers=${CONSUMER_REGRESSIONS.length} active-index=ok isolation=ok`);
