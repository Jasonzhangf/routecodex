#!/usr/bin/env node
import { run } from './_common.mjs';

await run('node', ['scripts/verify.mjs'], { timeoutMs: 15 * 60_000 });
await run('node', ['scripts/verify-red.mjs'], { timeoutMs: 15 * 60_000 });
await run('node', ['scripts/test.mjs'], { timeoutMs: 45 * 60_000 });
await run('node', ['scripts/build.mjs'], { timeoutMs: 25 * 60_000 });
process.stdout.write('[v3 verify:ci] PASS\n');
