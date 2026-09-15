#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(root, 'scripts', 'run-v3-cargo-test.mjs'), 'utf8');

assert.match(source, /CARGO_TEST_TIMEOUT_MS\s*=\s*40\s*\*\s*60\s*\*\s*1000/u);
assert.match(source, /process\.kill\(child\.pid, 'SIGTERM'\)/u);
assert.match(source, /process\.kill\(child\.pid, 'SIGKILL'\)/u);
assert.match(source, /cargo test timed out after \$\{timeoutMs\}ms/u);
assert.match(source, /clearTimeout\(timeoutTimer\)/u);

process.stdout.write('[test:v3-cargo-test-timeout-regression] PASS\n');
