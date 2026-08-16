#!/usr/bin/env node
/**
 * Canonical V4 build entrypoint: Cargo workspace release build with the
 * tracked lock enforced. All output stays under v4/target.
 */
import { run } from './_common.mjs';

run('cargo build --release --manifest-path Cargo.toml --locked');
console.log('[v4 build] OK cargo workspace release build (locked)');
