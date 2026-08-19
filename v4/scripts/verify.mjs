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
import { ARCHITECTURE_GATES, CONSUMER_REGRESSIONS } from './_gate-matrix.mjs';

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

run('node scripts/compile-real-runtime-manifest.mjs');
run('cargo run --quiet --manifest-path Cargo.toml -p routecodex-v4-skeleton --bin routecodex-v4-plan-hash -- contracts/skeleton-plan.contract.json --check');
run('cargo build --release --manifest-path Cargo.toml --locked');
restoreHermeticActive();
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-consumer --root . --consumer routecodex-v4-runtime --deps routecodex-v4-error,routecodex-v4-base-node,routecodex-v4-control --source-deps routecodex-v4-cordis-bridge,routecodex-v4-skeleton,routecodex-v4-plugin-contract --out build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- test-binary --root . --consumer routecodex-v4-runtime-bin --deps routecodex-v4-base-node,routecodex-v4-error,routecodex-v4-control --source-deps routecodex-v4-provider,routecodex-v4-router,routecodex-v4-server --rlib-deps routecodex-v4-runtime=build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib --out build-control/routecodex-v4-runtime-bin/tests');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-binary --root . --consumer routecodex-v4-runtime-bin --deps routecodex-v4-base-node,routecodex-v4-error,routecodex-v4-control --source-deps routecodex-v4-provider,routecodex-v4-router,routecodex-v4-server --rlib-deps routecodex-v4-runtime=build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib --out target/release/rccv4');

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
