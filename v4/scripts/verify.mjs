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
