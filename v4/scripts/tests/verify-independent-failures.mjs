#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runIndependent } from '../_common.mjs';

const v4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commonUrl = pathToFileURL(path.join(v4Root, 'scripts/_common.mjs')).href;
const failingCommand = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;
const driver = `
import { run } from ${JSON.stringify(commonUrl)};

for (const label of ['first', 'second']) {
  console.log(label);
  run(${JSON.stringify(failingCommand)});
}
`;

const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
  cwd: v4Root,
  encoding: 'utf8',
});
assert.notEqual(result.status, 0, 'the sequential runner must fail on the first failed command');
assert.equal(result.stdout, 'first\n',
  'the current sequential runner must stop before the second failed command');
console.log('[v4 regression] current sequential behavior: first failure stops the matrix');

const failures = runIndependent([
  { label: 'first', command: failingCommand },
  { label: 'second', command: failingCommand },
]);
assert.deepEqual(failures.map(({ label }) => label), ['first', 'second'],
  'the bounded collector must retain both independent fatal failures');
console.log('[v4 regression] collected behavior: both independent failures are reported');
