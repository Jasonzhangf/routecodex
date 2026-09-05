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
import { ARCHITECTURE_GATES, CONSUMER_REGRESSIONS, RUST_GATES } from './_gate-matrix.mjs';

run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');
// V4-LAYER-PREFLIGHT-END

function restoreHermeticActive() {
  const project = JSON.parse(fs.readFileSync(path.join(v4Root, '.appsdk/project.json'), 'utf8'));
  for (const module of project.modules.filter((entry) => entry.stage === 'frozen')) {
    // Active is immutable. Only the lifecycle owner can reconstruct its
    // missing projection from the bound archive; fixtures never replace it.
    if (!/^[a-z0-9-]+$/.test(module.module_id)) throw new Error('invalid module id');
    const current = path.join(v4Root, 'active/lib', module.module_id, 'current.json');
    if (!fs.existsSync(current)) {
      run(`/Users/fanzhang/.cargo/bin/appsdk rehydrate-frozen . --module ${module.module_id}`);
    }
  }
  // Source CI does not republish frozen modules or certify their historical
  // deployment evidence. Active integrity remains enforced by build-link,
  // its consumers and index verification below. Explicit release verification
  // keeps the full SDK lifecycle check; failures are never downgraded there.
  const sourceOnly = process.env.RCCV4_REAL_RUNTIME_ADMISSION_MODE === 'contract';
  run(`/Users/fanzhang/.cargo/bin/appsdk verify ${sourceOnly ? '--admission ' : ''}.`);
}

run('cargo run --quiet --manifest-path Cargo.toml -p routecodex-v4-skeleton --bin routecodex-v4-plan-hash -- contracts/skeleton-plan.contract.json --check');
run('cargo build --release --manifest-path Cargo.toml --locked');
restoreHermeticActive();
run('node scripts/build.mjs');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- test-binary --root . --consumer routecodex-v4-runtime-bin --deps routecodex-v4-base-node,routecodex-v4-edge,routecodex-v4-control,routecodex-v4-error --source-deps routecodex-v4-cli,routecodex-v4-cordis-bridge,routecodex-v4-debug,routecodex-v4-lifecycle,routecodex-v4-node-container,routecodex-v4-plugin-plan,routecodex-v4-servertool,routecodex-v4-skeleton,routecodex-v4-standard-plugins --rlib-deps routecodex_v4_config=build-control/routecodex-v4-config/libroutecodex_v4_config.rlib,routecodex_v4_provider=build-control/routecodex-v4-provider/libroutecodex_v4_provider.rlib,routecodex_v4_router=build-control/routecodex-v4-router/libroutecodex_v4_router.rlib,routecodex_v4_runtime=build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib,routecodex_v4_server=build-control/routecodex-v4-server/libroutecodex_v4_server.rlib --out build-control/routecodex-v4-runtime-bin/tests');

for (const gate of ARCHITECTURE_GATES) {
  run(`node scripts/architecture/${gate}`);
}

// The control-event lifecycle gate is a Rust owner gate, so invoke its
// positive/negative suite explicitly in the canonical admission path.
for (const [, command] of RUST_GATES) run(command);

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
