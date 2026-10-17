#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runAll } from '../_common.mjs';

const warningCommand = ['node', '-e', "console.error('WARN_FIXTURE'); process.exit(17)"];
const blockingCommand = ['node', '-e', "console.error('BLOCK_FIXTURE'); process.exit(18)"];
const afterCommand = ['node', '-e', "console.log('AFTER_FIXTURE')"];

const result = await runAll([
  { label: 'explicit-warning', command: warningCommand[0], args: warningCommand.slice(1), severity: 'WARN' },
  { label: 'explicit-block', command: blockingCommand[0], args: blockingCommand.slice(1), severity: 'BLOCK' },
  { label: 'after-independent-failures', command: afterCommand[0], args: afterCommand.slice(1), severity: 'BLOCK' },
]);

assert.equal(result.warnings.length, 1, JSON.stringify(result));
assert.match(result.warnings[0], /WARN_FIXTURE/);
assert.equal(result.failures.length, 1, JSON.stringify(result));
assert.match(result.failures[0], /BLOCK_FIXTURE/);

const undeclaredSeverity = await runAll([
  { label: 'undeclared-severity', command: blockingCommand[0], args: blockingCommand.slice(1) },
]);
assert.equal(undeclaredSeverity.failures.length, 1, JSON.stringify(undeclaredSeverity));
assert.equal(undeclaredSeverity.warnings.length, 0, JSON.stringify(undeclaredSeverity));
assert.match(undeclaredSeverity.failures[0], /severity must be explicitly declared/);

const invalidAndIndependent = await runAll([
  { label: 'invalid-severity', command: blockingCommand[0], args: blockingCommand.slice(1), severity: 'OPTIONAL' },
  { label: 'after-invalid-severity', command: blockingCommand[0], args: blockingCommand.slice(1), severity: 'BLOCK' },
]);
assert.equal(invalidAndIndependent.warnings.length, 0, JSON.stringify(invalidAndIndependent));
assert.equal(invalidAndIndependent.failures.length, 2, JSON.stringify(invalidAndIndependent));
assert.match(invalidAndIndependent.failures[0], /invalid gate severity: OPTIONAL/);
assert.match(invalidAndIndependent.failures[1], /BLOCK_FIXTURE/);

process.stdout.write('[test:v3-gate-severity-regression] PASS\n');
