#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runAll } from '../_common.mjs';

const missingRequiredCommand = 'routecodex-required-command-does-not-exist-095abcd';
const required = await runAll([
  { label: 'required-missing', command: missingRequiredCommand },
]);

assert.equal(required.failures.length, 1, JSON.stringify(required));
assert.equal(required.warnings.length, 0, JSON.stringify(required));
assert.match(required.failures[0], new RegExp(`${missingRequiredCommand} .*unavailable`));
assert.match(required.failures[0], /spawn .* ENOENT/);

const missingOptionalCommand = 'routecodex-optional-command-does-not-exist-095abcd';
const optional = await runAll([
  { label: 'optional-diagnostic', command: missingOptionalCommand, optional: true },
]);

assert.equal(optional.failures.length, 0, JSON.stringify(optional));
assert.equal(optional.warnings.length, 1, JSON.stringify(optional));
assert.match(optional.warnings[0], new RegExp(`${missingOptionalCommand} .*unavailable`));
assert.match(optional.warnings[0], /spawn .* ENOENT/);

process.stdout.write('[test:v3-aggregate-environment-availability-regression] PASS\n');
