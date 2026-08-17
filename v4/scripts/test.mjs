#!/usr/bin/env node
/**
 * Canonical V4 test entrypoint: workspace tests (including build-link
 * resolver/compile-fail red tests) with the tracked lock enforced.
 */
import { run } from './_common.mjs';

run('cargo test --workspace --manifest-path Cargo.toml --locked');
run('node --test cordis/routecodex-v4-cordis-host/tests/host.test.mjs');
console.log('[v4 test] OK cargo workspace tests (locked)');
console.log('[v4 test] OK real Cordis host tests');
