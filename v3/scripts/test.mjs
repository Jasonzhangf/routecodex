#!/usr/bin/env node
import { run } from './_common.mjs';

await run(
  'node',
  ['scripts/run-v3-cargo-test.mjs', '--locked', '--workspace', '--', '--nocapture'],
  { timeoutMs: 45 * 60_000 },
);
process.stdout.write('[v3 test] PASS\n');
