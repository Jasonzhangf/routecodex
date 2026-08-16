#!/usr/bin/env node
import { run } from './_common.mjs';

run('node', ['scripts/run-v3-cargo-test.mjs', '--locked', '--workspace', '--', '--nocapture']);
process.stdout.write('[v3 test] PASS\n');
