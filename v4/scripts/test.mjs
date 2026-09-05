#!/usr/bin/env node
/**
 * Canonical V4 test entrypoint: workspace tests (including build-link
 * resolver/compile-fail red tests) with the tracked lock enforced.
 */
import { run } from './_common.mjs';

run('node --test scripts/test-git-hooks.test.mjs scripts/test-lifecycle-adapter.test.mjs');
run('cargo test --manifest-path Cargo.toml -p routecodex-v4-node-container --bin routecodex-v4-node-container-host --locked');
run('cargo test --workspace --manifest-path Cargo.toml --locked');
run('node --test cordis/routecodex-v4-cordis-host/tests/*.test.mjs');
console.log('[v4 test] OK cargo workspace tests (locked)');
console.log('[v4 test] OK real Cordis host + Rust NodeContainer binding tests');
