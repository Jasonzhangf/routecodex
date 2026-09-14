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

const implicitBlock = await runAll([
  { label: 'implicit-block', command: blockingCommand[0], args: blockingCommand.slice(1) },
]);
assert.equal(implicitBlock.warnings.length, 0, JSON.stringify(implicitBlock));
assert.equal(implicitBlock.failures.length, 1, JSON.stringify(implicitBlock));

await assert.rejects(
  runAll([{ label: 'invalid-severity', command: afterCommand[0], args: afterCommand.slice(1), severity: 'OPTIONAL' }]),
  /invalid gate severity: OPTIONAL/,
);

process.stdout.write('[test:v3-gate-severity-regression] PASS\n');
