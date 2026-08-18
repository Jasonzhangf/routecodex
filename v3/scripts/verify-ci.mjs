#!/usr/bin/env node
import { run } from './_common.mjs';

run('node', ['scripts/verify.mjs']);
run('node', ['scripts/verify-red.mjs']);
run('node', ['scripts/test.mjs']);
run('node', ['scripts/build.mjs']);
process.stdout.write('[v3 verify:ci] PASS\n');
